#!/bin/bash
# Guild doctor — walks the whole setup chain and, on each failure, names the
# broken prerequisite, the fix, and the owning secret group (deploy/README.md
# normative names). Exit 0 = all green; exit 1 = at least one failure.
# Never prints secret values.
set -u

MULTICA=${DOCTOR_MULTICA_URL:-http://multica-backend:8080}
GATEWAY=${DOCTOR_GATEWAY_URL:-http://litellm:4000}
CHEAP_MODEL=${DOCTOR_CHEAP_MODEL:-or-gemini-flash-lite}
FAILURES=0

ok()   { printf '  [OK]   %s\n' "$1"; }
fail() { # fail <what> <prerequisite> <fix> <owning-secret>
  printf '  [FAIL] %s\n         prerequisite: %s\n         fix: %s\n         owning secret: %s\n' "$1" "$2" "$3" "$4"
  FAILURES=$((FAILURES + 1))
}

echo "guild doctor — checking the setup chain"

# 1. Required env (control plane can't even boot without these)
echo "[1/7] .env completeness"
missing=""
for v in MULTICA_JWT_SECRET MULTICA_POSTGRES_PASSWORD LITELLM_MASTER_KEY LITELLM_SALT_KEY LITELLM_POSTGRES_PASSWORD GUILD_POSTGRES_PASSWORD; do
  [ -z "${!v:-}" ] && missing="$missing $v"
done
if [ -n "$missing" ]; then
  fail "unset variables:$missing" ".env copied from .env.example and filled" \
    "set each listed var to any long random string, then: docker compose up -d" \
    "multica-app / litellm-app / guild-conductor (see the .env section headers)"
else
  ok ".env core secrets are set"
fi
if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  fail "no model-provider key set" "at least one of OPENROUTER_API_KEY / ANTHROPIC_API_KEY" \
    "set OPENROUTER_API_KEY (recommended, D9) in .env, then: docker compose up -d litellm" \
    "litellm-app"
else
  ok "a model-provider key is set"
fi

# 2. Multica control plane
echo "[2/7] Multica backend"
health=$(curl -fsS --max-time 5 "$MULTICA/healthz" 2>/dev/null)
if echo "$health" | jq -e '.status == "ok"' >/dev/null 2>&1; then
  ok "backend healthy ($(echo "$health" | jq -c .checks))"
else
  fail "backend unreachable or unhealthy at $MULTICA/healthz" \
    "multica-backend container up (first boot runs migrations ~20s)" \
    "docker compose up -d; docker compose logs multica-backend" \
    "multica-app (DB password / JWT secret mismatches surface here)"
fi

# 3. Gateway
echo "[3/7] LiteLLM gateway"
if curl -fsS --max-time 5 "$GATEWAY/health/liveliness" >/dev/null 2>&1; then
  ok "gateway alive"
else
  fail "gateway unreachable at $GATEWAY" \
    "litellm container up (first boot runs Prisma migrations ~60s)" \
    "docker compose up -d; docker compose logs litellm" \
    "litellm-app"
fi

# 4. Model route (master key, cheap tier — a fraction of a cent)
echo "[4/7] model route ($CHEAP_MODEL)"
if [ -n "${LITELLM_MASTER_KEY:-}" ]; then
  resp=$(curl -fsS --max-time 60 -X POST "$GATEWAY/v1/messages" \
    -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H content-type:application/json \
    -d "{\"model\":\"$CHEAP_MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"Reply OK\"}]}" 2>/dev/null)
  if echo "$resp" | jq -e '.content[0].text' >/dev/null 2>&1; then
    ok "completion via gateway succeeded"
  else
    fail "gateway completion failed for $CHEAP_MODEL" \
      "a valid provider key behind the gateway route" \
      "check OPENROUTER_API_KEY in .env, then: docker compose restart litellm; docker compose logs litellm" \
      "litellm-app"
  fi
else
  fail "cannot test model route" "LITELLM_MASTER_KEY set" "see check 1" "litellm-app"
fi

# 5. Daemon credentials minted (the post-boot ordering step)
echo "[5/7] daemon credentials"
if [ -z "${MULTICA_DAEMON_TOKEN:-}" ]; then
  fail "MULTICA_DAEMON_TOKEN is empty" \
    "a Multica personal access token minted AFTER the control plane is up" \
    "http://localhost:3000 -> Settings -> Tokens -> create (mul_...), paste into .env, then: docker compose --profile daemon up -d" \
    "guild-daemon"
else
  me=$(curl -fsS --max-time 5 "$MULTICA/api/me" -H "Authorization: Bearer $MULTICA_DAEMON_TOKEN" 2>/dev/null)
  if echo "$me" | jq -e '.id' >/dev/null 2>&1; then
    ok "PAT valid (user: $(echo "$me" | jq -r '.email // .name'))"
  else
    fail "PAT rejected by Multica" "a live, unexpired mul_ token" \
      "re-mint at http://localhost:3000 Settings -> Tokens; update .env; docker compose --profile daemon up -d --force-recreate" \
      "guild-daemon"
  fi
fi
if [ -z "${GUILD_DAEMON_VIRTUAL_KEY:-}" ]; then
  fail "GUILD_DAEMON_VIRTUAL_KEY is empty" \
    "a LiteLLM virtual key minted AFTER the gateway is up" \
    "http://localhost:4000/ui (login: LITELLM_MASTER_KEY) -> create key WITH max_budget; paste into .env; docker compose --profile daemon up -d --force-recreate" \
    "guild-daemon"
else
  vresp=$(curl -fsS --max-time 60 -X POST "$GATEWAY/v1/messages" \
    -H "Authorization: Bearer $GUILD_DAEMON_VIRTUAL_KEY" -H content-type:application/json \
    -d "{\"model\":\"$CHEAP_MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"Reply OK\"}]}" 2>/dev/null)
  if echo "$vresp" | jq -e '.content[0].text' >/dev/null 2>&1; then
    ok "virtual key serves traffic"
  else
    fail "virtual key rejected (revoked, or budget exhausted -> 429 budget_exceeded)" \
      "a live virtual key with remaining budget" \
      "re-mint in the LiteLLM UI; update .env; docker compose --profile daemon up -d --force-recreate" \
      "guild-daemon"
  fi
fi

# 6. Runtime registered (needs the PAT)
echo "[6/7] daemon runtime"
if [ -n "${MULTICA_DAEMON_TOKEN:-}" ]; then
  ws=$(curl -fsS --max-time 5 "$MULTICA/api/workspaces" -H "Authorization: Bearer $MULTICA_DAEMON_TOKEN" 2>/dev/null | jq -r '.[0].id // empty')
  if [ -n "$ws" ]; then
    online=$(curl -fsS --max-time 5 "$MULTICA/api/runtimes" -H "Authorization: Bearer $MULTICA_DAEMON_TOKEN" -H "X-Workspace-ID: $ws" 2>/dev/null | jq -r '[.[] | select(.status == "online") | .name] | join(", ")')
    if [ -n "$online" ]; then
      ok "online runtime(s): $online"
    else
      fail "no online runtime in workspace" "the daemon container running and registered" \
        "docker compose --profile daemon up -d --build; docker compose logs guild-daemon" \
        "guild-daemon (bad MULTICA_DAEMON_TOKEN also lands here)"
    fi
  else
    fail "no workspace visible to the PAT" "a workspace created in the Multica UI" \
      "http://localhost:3000 -> create a workspace, then re-run doctor" \
      "guild-daemon"
  fi
else
  fail "cannot check runtimes" "MULTICA_DAEMON_TOKEN set" "see check 5" "guild-daemon"
fi

# 7. Git credentials (external call; informational but named)
echo "[7/7] git PAT"
if [ -z "${GUILD_DAEMON_GITHUB_TOKEN:-}" ]; then
  fail "GUILD_DAEMON_GITHUB_TOKEN is empty" "a fine-grained PAT scoped to the target repo(s)" \
    "create at github.com -> Settings -> Developer settings -> fine-grained tokens; paste into .env" \
    "guild-daemon"
elif curl -fsS --max-time 10 https://api.github.com/user -H "Authorization: Bearer $GUILD_DAEMON_GITHUB_TOKEN" >/dev/null 2>&1; then
  ok "git PAT authenticates against GitHub"
else
  fail "git PAT rejected by GitHub (or no network egress)" "a live fine-grained PAT" \
    "re-issue the token; agents cannot push without it" \
    "guild-daemon"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "doctor: all checks green"
  exit 0
else
  echo "doctor: $FAILURES failure(s) — fixes above, in order"
  exit 1
fi
