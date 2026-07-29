Both migration files confirmed to exist. All load-bearing citations from both readers check out against the actual code at commit `beb3e9be65023f63bd5dfdbb0231ed41aa9f1cb8`. Final answer below.

---

# Multica — Consolidated Answers (Q1–Q5)

Repo: `github.com/multica-ai/multica`, commit `beb3e9be65023f63bd5dfdbb0231ed41aa9f1cb8`, clone at `/private/tmp/claude-501/-Users-maarten-git-bitstrum-agents/9cc19b02-d2f9-4857-a3c7-8483e0d51bf4/scratchpad/multica`. I re-read every load-bearing file cited below myself before accepting the reader claims; nothing here is taken on grep-trust alone. Both readers' factual claims held up — I found no fabrications, only minor imprecision (noted where relevant).

---

## Q1 — Per-task LLM context: fresh vs. resumed

**Answer:** Conditional resume, scoped to `(agent, issue)`, not purely fresh and not purely accumulating.

- The Claude CLI is invoked with `--resume <session_id>` **only if** `opts.ResumeSessionID != ""` — `server/pkg/agent/claude.go:706-708` (verified verbatim).
- `ResumeSessionID` is populated from `task.PriorSessionID`, set server-side at claim time, two distinct code paths I traced directly in `server/internal/handler/daemon.go` (~lines 1990-2045):
  - **Rerun of a task**: resumes from the exact source task's session, gated on `!ResumeUnsafeFailure(...)` and same `RuntimeID`.
  - **Non-rerun follow-up on the same issue** (the common case): `GetLastTaskSession(AgentID, IssueID)` picks the most recent non-poisoned session for that exact pair, also runtime-gated.
- The daemon re-gates this further: `gateResumeToReusedWorkdir` (`server/internal/daemon/daemon.go:4225-4245`, confirmed verbatim) drops the prior session unless the task actually lands in the identical workdir — because Claude Code keys sessions to `~/.claude/projects/<encoded-cwd>/`.
- If `--resume` is rejected by the CLI (session gone, bound to another account), one fresh-session retry fires with an explicit continuity-loss notice injected into the prompt (`server/internal/daemon/prompt.go:19-22`, confirmed verbatim).

**Net:** same issue + same agent + same runtime + reused workdir + non-poisoned session → true CLI-native session resume (conversational memory persists). Anything else (new issue, cross-runtime, GC'd workdir, rejected resume, forced rerun) → fresh CLI session, no memory.

**Confidence: VERIFIED-IN-CODE.**
Evidence: `server/pkg/agent/claude.go:668-726`, `server/internal/daemon/daemon.go:4225-4245` (`gateResumeToReusedWorkdir`), `:5271` (`ResumeSessionID: task.PriorSessionID`), `server/internal/handler/daemon.go:~1990-2045`, `server/pkg/db/queries/agent.sql` (`GetLastTaskSession`), `server/migrations/020_task_session.up.sql` (exists, confirmed), `server/internal/daemon/prompt.go:19-22`.

**Guild-vs-multica overlap matrix update — "context-fresh" cell (was UNKNOWN):**
Change it from UNKNOWN to a **qualified answer, not binary**: context is resumed within an (agent, issue) pair under normal conditions, fresh otherwise. If Guild's design assumed either "always fresh, no memory leakage between turns" or "always accumulating, full history retained," both assumptions are wrong — Guild needs to account for the workdir/runtime-gating logic if it wants comparable behavior, or explicitly design against it if it wants stronger isolation guarantees than Multica provides.

---

## Q2 — Blocker/question → human reply routing

**Answer:** No live "ask a question" channel exists — Claude Code's `AskUserQuestion` tool is hard-disabled (`claude.go:675-681`, confirmed verbatim: *"the daemon runs Claude in non-interactive stream-json mode and has no UI for the prompt to render in"*). Blockers are raised via `multica issue status <id> blocked` + a normal comment, per the injected runtime brief.

**Human reply → agent routing (traced and confirmed in `server/internal/handler/comment.go`):**
1. `CreateComment` (line 1245, confirmed exact) → `triggerTasksForComment` (line 1464, confirmed exact) → `computeCommentAgentTriggers` (line 2107, confirmed exact).
2. Structured, not content-based: `routeReplyToParentAuthor` (line 2216, confirmed exact — I read the full function body) routes a reply to the same agent that authored the parent comment; `routeThreadRootOwners`/`routeConversationContinuationToAgent` (lines 2241/2334, confirmed exact) route thread continuations similarly.
3. A new `agent_task_queue` row is created for that agent/issue with `trigger_comment_id` set (I confirmed the actual enqueue call sites are `TaskService.EnqueueTaskForThreadParent`/`EnqueueTaskForSquadLeader` inside `enqueueSingleCommentTrigger`, line 2038 — Reader 1 named this function slightly imprecisely as "`enqueueCommentAgentTriggers`" but the mechanism, line ranges, and logic are correct).
4. Session resume then follows exactly the Q1 mechanics.
5. `buildCommentPrompt` (prompt.go:221, confirmed present) explicitly injects the new comment text into that turn's prompt rather than relying on the model to "remember" — so it's resume *plus* explicit re-injection, not one or the other.

**Confidence: VERIFIED-IN-CODE.**
Evidence: `server/internal/handler/comment.go:1245,1464,2107,2216,2241,2038`, `server/internal/daemon/prompt.go:19-22,221`, `server/migrations/020_task_session.up.sql` and `028_task_trigger_comment.up.sql` (both confirmed to exist on disk).

**Matrix update — "question routing" cell (was PARTIAL/UNKNOWN):**
Upgrade to **fully resolved, VERIFIED**: routing is deterministic (parent-author / thread-root / conversation-continuation rules — not LLM-guessed), and continuity is layered (session resume + explicit content injection + disclosed fallback on resume failure). If Guild was uncertain whether it needed its own reply-correlation logic on top of Multica's comment API, it doesn't for the common case — Multica already resolves "who does this reply go to" server-side before Guild would ever see the comment. Guild does need to know that a reply to an agent's comment on an issue with no prior task history, or across a runtime change, gets no session continuity and must be self-contained.

---

## Q3 — Budget caps / kill-switch

**Answer: recording only, confirmed absent as enforcement.** I independently re-ran the grep sweep myself (not just trusting the reader's transcript) across `server/` and `.env.example`:
- `grep -ril "budget" server` → every hit is either a non-monetary "budget" (webhook payload size, delivery batching, comment-summary rune budget — confirmed by reading `server/internal/handler/daemon.go` and `cloud_billing.go` hit lines directly) or provider-quota-error classification, never a Multica-side dollar ceiling.
- I read the full `.env.example` (362 lines) myself: zero cost/budget/spend/quota-denominated variables exist anywhere.
- `task_usage`/`task_usage_hourly` tables (migrations `032` and `213`, both read in full) are pure recording — token counts and, where the provider reports it, authoritative USD cost — feeding dashboards/Prometheus, with no threshold column and no comparison logic anywhere near them.
- `ExecOptions.MaxTurns` (`server/pkg/agent/agent.go:38`) is plumbed through and read at `claude.go:699-700` / `codebuddy.go:70-71`, but I grepped every call site across `server/` myself: the only places it's ever *set* to a nonzero value are two unit tests (`cursor_test.go:84`, `codebuddy_test.go:20`). No production daemon code path sets it. It's dead as a cost-containment lever today.

**Confidence: VERIFIED-IN-CODE** (for "no enforcement exists"). Absence claims are inherently harder to fully prove than presence claims (a rename/relocation could theoretically evade a keyword grep), so treat the negative as "no enforcement found under any recognizable name," not "provably impossible to exist."

Evidence: `.env.example` (full file, read directly), `server/migrations/032_task_usage.up.sql` and `213_task_usage_authoritative_cost.up.sql` (both read in full), `server/pkg/agent/agent.go:38`, `server/pkg/agent/claude.go:699-700`, my own `grep -rn "MaxTurns" server/`, `server/internal/handler/cloud_billing.go` (Stripe topup, not a task-admission gate).

**Matrix update — "budget kill-switch" cell (was high-confidence-absent):**
Confirmed and strengthened to **VERIFIED-absent** (was inference from partial grep before; now independently re-run and read in full). No change in direction, only in confidence level. If Guild needs a spend ceiling that stops agents from running once a budget is hit, it must build that itself — nothing in Multica provides even a partial primitive for it (not even the dead `MaxTurns` knob, since nothing wires it up).

---

## Q4 — Personal K8s cluster deployment sketch

**What the official Helm chart (`deploy/helm/multica/`, Chart v0.1.0) gives you** — confirmed by reading `Chart.yaml` and every template file:
- Three components only: **postgres** (pgvector/pgvector:pg17, PVC-backed, skippable if using external Postgres), **backend** (Deployment, `strategy: Recreate`, PVC for uploads), **frontend** (Next.js standalone Deployment). Plus Ingress (two hosts), a ConfigMap, and an optional PrometheusRule.
- **No daemon component exists in the chart at all** — no template, no values.yaml section, no image reference. I confirmed this by listing `deploy/helm/multica/templates/` directly: `_helpers.tpl backend.yaml configmap.yaml frontend.yaml ingress.yaml postgres.yaml prometheusrule.yaml`. Nothing else.

**What you build yourself — the daemon:**
- No `multica-daemon` container image is published anywhere. I confirmed `docker/entrypoint.sh` (4 real lines) only runs `./migrate up` then `exec ./server` — even though the backend `Dockerfile` (read in full) copies the `multica` CLI binary into the image at line 33 alongside `server`/`migrate`, that binary's `daemon` subcommand is never invoked by the entrypoint. Its presence looks incidental to the build pipeline, not a deployment path.
- Docs state the host-only design explicitly and repeatedly — I confirmed the exact wording in `SELF_HOSTING.md:101` ("The daemon runs on your local machine (not inside Docker)"), `SELF_HOSTING.md:299` (K8s section: "The daemon runs on your local machine, not in the cluster"), and `apps/docs/content/docs/daemon-runtimes.mdx` (title/description line: "Agents don't run on Multica's servers — they run on your own machines"; body confirms "A runtime is not a server and not a container"). This is a stated architectural position, not a gap.
- Reader 2's GitHub issue citations (#4020 "containerized runtime + network allowlist" request, #1370 maintainer reply endorsing a self-built combined image, #1104 container friction) are **not independently re-verifiable from this local clone** — I could not check them against the live GitHub repo in this pass. Treat those specific claims (issue numbers, exact maintainer quotes, dates) as **DOCUMENTED** (reader used WebSearch/gh, which is a legitimate but different evidence channel than the code I re-read) rather than VERIFIED-IN-CODE. The architectural facts (no daemon image, no Helm template, docs say host-only) are independently VERIFIED-IN-CODE regardless of whether the GitHub issue detail is accurate.

**Concrete deployment sketch for your personal cluster:**

```
Namespace: multica
├── helm install multica ./deploy/helm/multica   # postgres + backend + frontend + ingress
│     - set existingSecret to a pre-created K8s Secret (JWT, DB creds, etc.)
│     - postgres.external.enabled=true if you'd rather run your own PG
│
└── (build yourself) daemon Deployment — NOT in the chart, NOT official
      - Custom image: FROM your base, COPY the `multica` binary,
        install agent CLIs (claude, codex, opencode, ...) + their own
        API-key auth (separate from Multica's token)
      - git + credentials baked in or mounted (SSH key / credential helper) —
        confirmed the daemon shells directly to the host `git` binary
        (server/internal/daemon/execenv/git.go, exec.Command("git", ...))
        and does NOT seed git auth for you
      - Container ENTRYPOINT: `multica login --token <mdt_ or PAT>` then
        `multica daemon start --foreground` as PID 1
      - Own Secret for the token, pointed at your in-cluster backend Service
```

**Gotchas confirmed from code/docs:**
- **CLI auth inside pods**: headless login via `multica login --token <mul_...>` works (no browser needed) — confirmed in `CLI_AND_DAEMON.md:72-76` and `auth-tokens.mdx` (PAT `mul_...` full-user scope, daemon token `mdt_...` narrower/workspace-scoped, auto-refreshed by the daemon). Interactive login defaults to opening a browser, so you must use `--token` in a headless pod.
- **No sandboxing**: the daemon forks agent CLIs as direct subprocesses on whatever host it's on. Running it in a pod gives the agent CLI the same blast radius as any process in that pod — no container-boundary isolation is added by Multica's own code (I confirmed no sandbox/jail/seccomp logic in `server/internal/daemon/execenv/`). If you want a security boundary, the pod boundary itself is your only one — build accordingly (least-privilege ServiceAccount, resource limits, network policy).
- **Every credential must be supplied by you**: git creds, each agent CLI's own API key, package registry auth — Multica's design philosophy is explicitly "your API keys never touch our server" (`daemon-runtimes.mdx`), which also means nothing is seeded for you inside a container.
- **Roadmap**: "Cloud runtimes" (server-side execution, no local daemon) is on a waitlist per `daemon-runtimes.mdx` — confirmed present in the doc — but that's a different, Multica-hosted architecture, not something you can enable on your own cluster today.

**Confidence: VERIFIED-IN-CODE** for the Helm chart contents, Dockerfile/entrypoint behavior, and doc quotes (all re-read directly). **DOCUMENTED** for the specific GitHub issue numbers/maintainer quotes (re-verify with `gh issue view 4020 -R multica-ai/multica` and `gh issue view 1370 -R multica-ai/multica` if those specifics matter to you). **INFERRED** for the "nothing in the daemon's Go code is Docker-hostile" claim — plausible from what I read (it's a static-ish Go binary shelling to `git` and CLI binaries) but I did not attempt an actual container build to confirm it works end-to-end.

---

## Q5 — License, personal + open-source use

**Plain-language conclusion:** For a single individual self-hosting Multica for personal use, and separately running your own independent open-source project (Guild) that only talks to your own private instance over the API — **you're fine, no commercial license needed.** The license (`LICENSE`, root, 45 lines, read in full — text matches reader's transcription character-for-character) has one carve-out that covers this exactly: *"Internal use within a single organization (including multiple workspaces) does not require a commercial license"* (`LICENSE:19-20`). The commercial-license trigger is specifically **hosting Multica's source for third parties** or **embedding it in something sold to third parties** (`LICENSE:10-14`) — Guild, as described, does neither.

**But two things would flip this, and they're easy to drift into without noticing:**
1. **The moment your instance starts serving other people** — not just you calling it from Guild, but Guild acquiring its own separate users who all point at your one backend — that's "hosted service to third parties" and the carve-out stops applying.
2. **The producer can tighten the license at any time** (`LICENSE:34-35`, clause 2.a) — this is not standard Apache-2.0 behavior (Apache-2.0 is version-locked and irrevocable); it's a vendor reservation clause layered on top. The file calling itself "# Open Source License" is marketing framing — it is **source-available with a field-of-use restriction**, not OSI-approved open source. Today's "you're fine" reading is not guaranteed to hold for future releases.

**Confidence: DOCUMENTED** (license text is unambiguous and fully read; the *application* of "single organization" to a lone individual is not defined anywhere in the license or repo, so that specific inferential step is **INFERRED**, not verified — I confirmed no FAQ/interpretation doc exists anywhere in the repo).

Evidence: `LICENSE` (root, full text read directly, 45 lines), `find . -iname "LICENSE*"` (confirmed only one LICENSE file exists in the whole repo), `apps/desktop/package.json:17` (`"license": "UNLICENSED"`, confirmed — this is npm publish metadata, not a competing legal license).

---

## What remains genuinely unknown, and how to close it fastest

1. **Q4 GitHub issue specifics** (exact wording of maintainer's #1370 reply, current status of #4020/#5636) — not re-verifiable from the local clone. **Fastest resolution:** `gh issue view 1370 -R multica-ai/multica` and `gh issue view 4020 -R multica-ai/multica` directly.
2. **Whether a custom daemon container actually runs cleanly in a pod** (git auth plumbing, agent-CLI binary compatibility with a minimal base image, non-interactive `multica login --token` behavior end-to-end) — I verified the pieces exist in code but did not build and run it. **Fastest resolution:** build the sketch above locally with `docker build`, run it against a local `multica login --token`, confirm `multica daemon start --foreground` claims a task successfully before committing to a K8s Deployment.
3. **Whether Multica, Inc. would agree with the "single individual = one organization" license reading in a contested scenario** — the license is silent, no interpretation doc exists. **Fastest resolution:** email Multica's stated producer contact (none published in the repo I found) or just ask them directly before Guild scales past your own personal use — cheap to ask now, expensive to be wrong about later.
4. **Whether other CLI backends' resume-gating (codex, opencode, hermes, etc.) behaves identically to Claude's** — I verified Claude's path in full; the reader's claim that "same architecture, different plumbing per backend file" for other providers is plausible from the `gateCodexResumeToRolloutPresence` reference I saw in the grep output, but I did not read `codex.go`/`opencode.go` myself. **Fastest resolution:** `grep -n "gate.*Resume" server/internal/daemon/daemon.go` and read the matched provider-specific gate functions directly if Guild depends on non-Claude backends.