# Guild — Tier 1 Docker Compose stack

The fully-isolated dev/quickstart stack: Multica control plane (execution
substrate), LiteLLM gateway (metering + budget caps), Guild's conductor
database, and the Guild-built Multica daemon container. This directory **is**
the shipped Tier 1 deliverable (deploy/README.md); the M1a capability proof
runs on exactly this stack.

Requirements: Docker with Compose v2, amd64 (the daemon image is amd64-only
for M1 — docker/daemon/README.md).

## Quickstart

Works identically on Windows, macOS, and Linux — the only prerequisite is
Docker with Compose v2; every command below is a compose verb (no `make`, no
host shell scripts).

**1. Configure.** Copy `.env.example` to `.env` and fill it in. Only two
values are external credentials you must obtain: a model-provider key
(`OPENROUTER_API_KEY` recommended) and a scoped GitHub PAT. Every other
secret is **any long random string** — use your password manager's generator
(or `openssl rand -hex 32` if you have it; the tool doesn't matter).

**2. Boot the control plane.**

```
docker compose up -d
```

**3. Mint the daemon's credentials** (they can only exist *after* boot —
that's the ordering trap, now a documented step, not a surprise):

- Multica UI at http://localhost:3000 — log in (dev stack: the fixed
  verification code from `.env`). **First login shows Multica's own onboarding
  — tutorials, a questionnaire, "connect local agents" prompts. Skip it all:
  none of it applies under Guild** (the daemon container *is* the agent
  connection, and `guild init` creates the team — issue #16). Then Settings →
  API Tokens → create a personal access token (`mul_…`) → paste into `.env` as
  `MULTICA_DAEMON_TOKEN`.
- LiteLLM admin UI at http://localhost:4000/ui — log in with
  `LITELLM_MASTER_KEY`, create a virtual key **with a `max_budget`** → paste
  into `.env` as `GUILD_DAEMON_VIRTUAL_KEY`.

**4. Start the daemon.**

```
docker compose --profile daemon up -d --build
```

**5. Verify.**

```
docker compose run --rm doctor
```

Doctor checks the whole chain (env → control plane → gateway → model route →
daemon credentials → registered runtime) and, on any failure, prints the
broken prerequisite, the fix, and which `.env` secret owns it. One boundary:
if a *core* secret is missing entirely, Compose itself refuses to start
anything — including doctor — with a `required variable <NAME> is missing`
error; that error names the variable, so it is the diagnosis (set it in
`.env` and re-run). Reset everything with `docker compose --profile "*" down -v` and
replay the quickstart (the `--profile "*"` matters: profile-gated services
like the daemon and conductor survive a plain `down` and would keep running
against the wiped databases — found live during the v0.1.0 replay).

**6. Initialize Guild** (M2b — the governance layer itself). Create a
workspace in the Multica UI (or reuse one), put its id in `.env` as
`GUILD_WORKSPACE_ID`, then:

```
docker compose run --rm guild-init
```

It provisions the conductor's own member identity (D11: real operator-vs-
conductor attribution) and the fixed four-role starter team, and prints the
three conductor values — paste them into `.env`
(`GUILD_MULTICA_TOKEN`, `GUILD_WORKSPACE_ID`, `GUILD_ROLE_AGENTS`), set
`GUILD_REPO_URL` (HTTPS with the scoped PAT embedded), and start the
conductor:

```
docker compose --profile conductor up -d --build
```

**7. Run the known-good demo.** Mint an operator PAT for yourself (Settings →
API Tokens, like step 3) into `.env` as `GUILD_OPERATOR_TOKEN`, then:

```
docker compose run --rm guild-demo
```

It posts the demo idea as a board ticket; the conductor answers with a
plan-approval ticket per stage. Everything after that happens on the board:
move a plan ticket to *Ready to work* to approve, comment `amend: <note>` to
revise, move a validated stage ticket to *Done* to accept. The emergency
stop is `docker compose run --rm guild-kill` — it cancels in-flight work,
revokes keys, and locks dispatch until you raise the caps in `.env` and
restart the conductor.

The daemon registers one runtime row per bundled CLI (sidebar: Configure → Runtimes;
OpenCode — the sole runtime, D9 as amended 2026-08-04), labeled by
`$MULTICA_DAEMON_DEVICE_NAME`. All agent model traffic flows
`CLI → litellm:4000 → provider`, authenticated by the virtual key — never a
provider key — so every call is metered and hard-capped (`max_budget`).
OpenCode agents use `provider/model`-qualified models against the baked
`litellm` provider (e.g. `litellm/or-claude-haiku-4-5`).

## Version pins

| Component | Pin | Where |
|---|---|---|
| Multica control plane | `v0.4.15` | `.env` `MULTICA_VERSION` |
| Multica CLI (in daemon image) | `0.4.15` | build arg `MULTICA_VERSION` |
| OpenCode CLI (in daemon image, sole runtime — D9 as amended 2026-08-04) | `1.18.10` | build arg `OPENCODE_VERSION` |
| LiteLLM | `v1.94.0` by digest `sha256:5287…b1e906` | `docker-compose.yml` |
| Postgres (Multica) | `pgvector/pgvector:pg17` | upstream requirement |
| Postgres (LiteLLM, Guild) | `postgres:17` | `docker-compose.yml` |

The Multica control-plane tag and the daemon image are a **lockstep pair**:
bump both together and run the substrate conformance suite green before either
moves (docker/daemon/README.md).

## Multica pin-bump procedure (license + behavior)

Multica is source-available with an internal-use carve-out (ARCHITECTURE.md
D8). On every pin bump, **before** changing `MULTICA_VERSION`:

```bash
git clone --depth 1 https://github.com/multica-ai/multica /tmp/multica-pin
cd /tmp/multica-pin
git fetch --depth 1 origin tag vNEW && git fetch --depth 1 origin tag vOLD
git diff vOLD vNEW -- LICENSE        # empty = no license change; anything else
                                     # → stop and review before bumping
```

Record the outcome in the bump commit message. Last review: `v0.4.15`
(2026-07-30) — LICENSE identical to the version frozen in
`docs/research/multica-investigation-2026-07-29.md`.

Then bump `MULTICA_VERSION` in `.env`/`.env.example`, rebuild the daemon image,
and run the conformance suite (M1b+) before deploying.

## Isolation

This stack talks only to: its own containers, GitHub (git + API for the
scratch/target repos), and the configured model provider(s). It uses **zero**
pre-existing services on the host or network — "test like a new user."

## Storage

Named volumes (`multica_pgdata`, `multica_uploads`, `litellm_pgdata`,
`guild_pgdata`) per the ground rules in deploy/README.md. The daemon container
deliberately has **no** volume: session/workdir state is ephemeral, and bounce
continuity across a daemon restart is best-effort by design (bounce comments
are self-contained — ARCHITECTURE.md D6).
