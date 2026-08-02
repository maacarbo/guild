# M1a capability matrix — Multica v0.4.15 on the Tier 1 compose stack

Frozen evidence (research convention: never edited after the fact — corrections
land as dated addenda). Probes from GitHub issue #1, run against
`deploy/compose/` on 2026-07-30 (stack authored at commit 53dcb59).

Environment: Docker (server 29.6.2, amd64) on the author's workstation.
Multica control plane `v0.4.15`; daemon image = `docker/daemon/` (Multica CLI
`0.4.15`, Claude Code `2.1.220`); LiteLLM `v1.94.0` (by digest).
`ANTHROPIC_API_KEY` was **not** available during this run: all model traffic
went through the `or-*` OpenRouter-backed routes (LiteLLM →
`openrouter/anthropic/claude-haiku-4.5`). Probes whose meaning depends on the
Anthropic-direct path are marked accordingly.

Two source-level reports (extracted from the v0.4.15 tree the same day)
back the live results below; source citations in the probe details refer to
paths in the upstream `multica-ai/multica` repository.

Verdict legend: **PASS** / **FAIL** / **PASS-WITH-WORKAROUND** (failure path
documented; exits M1a) / **UNCONFIRMED** (does not exit M1a; M1b follow-up) /
**PROVISIONAL** (passed via a substitute path; re-run needed).

| # | Probe | Verdict |
|---|-------|---------|
| P1 | Compose stack up: pinned Multica + isolated LiteLLM, healthz green | **PASS** |
| P2 | First-user creation scriptable (no browser) | **PASS** |
| P3 | Daemon container e2e: registers, claims + completes a task, pushes engagement branch | **PASS** |
| P4 | Cancel kills the CLI process + stops model traffic | **PASS** |
| P5 | Conductor-PAT comment triggers the agent | **PASS** |
| P6 | Replies on a closed issue still enqueue | **PASS** |
| P7 | Bounce after daemon restart (ephemeral session dirs) | **PASS** (caveat: branch identity not stable — SHA is the anchor) |
| P8 | Daemon-internal task concurrency | **PASS** (parallel; slot semaphore, default 20) |
| P9 | Two daemon containers register as distinct runtimes e2e | **PASS-WITH-WORKAROUND** (P9b recreate-orphaning failure path with proven repair) |
| P10 | Virtual-key `max_budget` stops at cap; 429 classification in Multica | **PASS** |
| P11 | Spend attribution: per-engagement key → task → attributable spend | **PASS** (gateway-side; Multica usage is zero for failed tasks) |
| P12 | Prompt caching + extended thinking survive the gateway | caching **PROVISIONAL** (passed via OpenRouter route); extended thinking **UNCONFIRMED** |
| P13 | REST read endpoints sufficient for reconciliation | **PASS** |
| P14 | WS events: task lifecycle + comments observable | **PASS** |
| P15 | Agent/squad management via API (best-effort) | **PASS** |

**M1a exit assessment — scope: probes P1–P15 only.** 13 of 15 exit clean
(PASS or PASS-WITH-WORKAROUND). Per the legend and ROADMAP's exit rule,
**two items do NOT yet exit**: P12's extended-thinking half (UNCONFIRMED — no
`--effort` flag observed; ARCHITECTURE.md D2 carries this as an M1 acceptance
test, so it must be closed during M1b conformance work) and P12's caching half
on the Anthropic-direct route (PROVISIONAL — proven via OpenRouter only).
ROADMAP M1a's ease-of-setup build items (`scripts/bootstrap.sh`,
`make up/down/reset/doctor`) are **outstanding and not assessed here**.
No design assumption was refuted; the findings sharpen the conductor design
(see "Design consequences" at the end).

## Probe details

### P1 — Stack bring-up
- `docker compose up -d` from `deploy/compose/` with a filled `.env`. Backend
  healthy after ~20s: `{"status":"ok","checks":{"db":"ok","migrations":"ok"}}`.
- LiteLLM needed ~60s extra on first boot for Prisma `migrate deploy` — not a
  failure.
- Compose gotcha (fixed in 53dcb59): `:?`-required variables are interpolated
  even for profile-gated services; the daemon token is enforced by the
  entrypoint instead.
- Gateway round-trip: Anthropic-format `POST /v1/messages` with
  `or-claude-haiku-4-5` → expected completion, usage recorded
  (`input_tokens: 18, output_tokens: 10`).

### P2 — Scripted first user
Full flow with zero browser interaction (script: bootstrap of the probe
workspace): `POST /auth/send-code` → `POST /auth/verify-code` (fixed dev code;
`APP_ENV=development`) → JWT → `POST /api/tokens` ×2 (`mul_` PATs: daemon +
conductor identities) → `POST /api/workspaces` → `PATCH /api/workspaces/{id}`
with `repos:[{url}]` (scratch-repo wiring) → LiteLLM `POST /key/generate`.
Caveat verified in source and live: the dev code only short-circuits the
comparison — `/auth/send-code` must still be called first to create a code row.
Token-type note: the daemon authenticated with a **`mul_` personal access
token** (full user scope); the narrower workspace-scoped `mdt_` daemon token
was not exercised in this run — M1b follow-up (deploy/README.md updated to
match the verified path).

### P3 — Daemon container e2e
- Headless login worked exactly as designed: `multica login --token` then
  `multica daemon start --foreground` (entrypoint); runtime row
  `Claude (guild-daemon-1)` online, named from `MULTICA_DAEMON_DEVICE_NAME`.
  (Note: Multica's `runtime_name` config key is parsed but never consumed —
  `device_name` is the real knob.)
- Issue assigned via API → task `b226c810` claimed and **completed in ~30s**:
  branch `agent/probe-claude/b226c810` pushed to the scratch repo, file content
  byte-exact. Branch naming = `agent/<sanitized-agent-name>/<task-id-first-8>`.
- Git auth: ambient only (daemon injects nothing) — the entrypoint's
  `credential.helper store` + `$HOME/.git-credentials` from `GITHUB_TOKEN`
  works for both daemon-side clone and agent-side push.
- Metering: Multica usage recorded (47 in / 1,873 out / 288,084 cache-read /
  25,850 cache-write tokens); LiteLLM virtual key spend **$0.116** — every
  model call went through the gateway.
- Trust boundary confirmed: the daemon spawns
  `claude -p … --permission-mode bypassPermissions --model <agent.model>`.
  **The container is the only sandbox.** (Supports D6 validator least-trust.)

### P4 — Cancel kills CLI
`POST /api/tasks/{id}/cancel` while `sleep 240` ran: task → `cancelled`;
process tree (claude.exe + bash + sleep) went 3 → 0 within 8s. No process =
no further model traffic. Cancelling an already-terminal task is a no-op
returning the row (not an error) — good for idempotent conductor retries.

### P5 — Conductor-PAT comment triggers agent
Comment posted with the second PAT on an `in_review` issue → task of
`kind: comment` with `trigger_comment_id` = that comment; completed and pushed
a follow-up commit **on the same branch** (same-session resume within daemon
lifetime; same `session_id` in all four task results for this issue).

### P6 — Closed-issue replies
Issue set `status: done`, then a threaded reply (`parent_id`) → task enqueued
and completed. **Multica's issue status does not gate execution** — Guild's
termination protocol (revoke key + close item; first persisted decision wins)
must be the enforcement layer, as designed. Also confirmed in source: issue
status changes never cancel in-flight tasks (MUL-4465) — cancel is always an
explicit API call.

### P7 — Bounce after daemon restart
`docker restart` (container fs preserved → same `daemon.id`, same runtime
row), session/workdir state gone. Self-contained bounce comment → fresh task
completed the work correctly, **but pushed to a new branch**
`agent/probe-claude/<new-task8>` (its commit extends the old branch's tip —
history preserved, name not). Branch identity is therefore stable only within
a daemon lifetime; across restarts the anchor must be the **commit SHA from
the task result**, never a predicted branch name. SHA-pinned contract
validation (D6) is the right call, verified from the failure side.

### P8 — Concurrency
Two issues on one agent, dispatched simultaneously: two `claude.exe` processes
observed side-by-side in one container, identical `started_at`, overlapping
runs. Source: machine-level slot semaphore, default 20
(`MULTICA_DAEMON_MAX_CONCURRENT_TASKS`); server serializes only per
(issue, agent). Per-agent `max_concurrent_tasks` exists as a column but has
**no enforcement in the claim path** (v0.4.15) — do not rely on it.

### P9 — Two daemons / P9b — recreate orphaning
- Second container (no shared volumes) → fresh `daemon.id` (UUIDv7) → distinct
  runtime row, both online, distinguished by `device_name`. **PASS.**
- **P9b failure path**: `docker rm` + recreate → *third* runtime row; the old
  row lingers "online" through its heartbeat staleness window; the agent bound
  to the dead runtime strands its new tasks in `queued` **silently, with no
  timeout observed** (>2 min). Repair proven live:
  `PUT /api/agents/{id} {"runtime_id": <new>}` + cancel stranded task +
  `POST /api/issues/{id}/rerun` → dispatched immediately. Note: rebinding the
  agent does **not** retarget already-queued tasks (they snapshot the runtime
  at enqueue) — cancel + rerun is required.

### P10 — max_budget stops at cap + 429 classification
Agent with per-agent `custom_env.ANTHROPIC_AUTH_TOKEN` = a fresh virtual key
with `max_budget: 0.001`:
- First call(s) passed (spend starts at 0); once spend landed, the gateway
  hard-rejected every call:
  `Request rejected (429) · Budget has been exceeded! … Current cost: 0.019, Max budget: 0.001`.
- Overshoot: $0.0193 on a $0.001 cap — LiteLLM's spend writes are batched
  (~60s window). **The cap is insurance, not precision** — sized caps must
  assume at least one full in-flight turn of overshoot. (Matches D2 wording.)
- Multica classification: task `failed` with
  `failure_reason: agent_error.provider_capacity_or_rate_limit` — the 429
  digit-boundary regex matches before any quota keyword ("budget" is not in
  Multica's quota list). **Non-retryable**: no auto-retry child; re-drive is
  manual (`rerun`).
- Latency nuance: between cap-hit and terminal `failed`, the task sat
  `running` ~3–4 min while Claude Code retried 429s with backoff. Guild's
  conductor should treat key exhaustion/revocation as an immediate cancel
  signal rather than waiting for natural failure.

### P11 — Spend attribution
- Gateway side: `engagement-p10` key spend ($0.019) fully isolated from
  `guild-daemon-default` ($0.337). Per-key = per-engagement attribution works;
  the substrate hook for per-engagement keys is **per-agent `custom_env`**
  (blocklist allows `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`; per-*task*
  env injection does not exist in v0.4.15).
- Multica side: `GET /api/issues/{id}/usage` returned **all zeros** for the
  failed P10 task — usage lands only on successful completion. **LiteLLM is
  the spend source of truth for failed engagements**; Multica usage is
  advisory. (Also: or-route tokens land in `uncosted_*` buckets — Multica's
  price table doesn't know gateway aliases; `cost_usd_ticks` stays 0.)

### P12 — Caching + extended thinking
- **Prompt caching: works through the gateway** even on the OpenRouter route —
  288,084 cache-read / 25,850 cache-write tokens on P3 (both reported by
  Multica usage and priced into LiteLLM spend). PROVISIONAL only in the sense
  that Anthropic-direct numbers should be captured when a direct key is
  available.
- **Extended thinking: UNCONFIRMED.** `PUT /api/agents/{id}` accepted and
  persisted `thinking_level: "high"`, but the spawned CLI (caught live via
  `ps`) showed **no `--effort` flag**. Source shows the flag exists
  conditionally; the condition did not fire here. M1b conformance-suite item;
  not load-bearing for M1a (no Guild requirement depends on it yet).

### P13 — REST reads
All 200 with usable shapes, PAT auth + `X-Workspace-ID` header:
`GET /api/issues` (filters), `GET /api/issues/{id}`, `/task-runs` (all
statuses + `failure_reason`/`error`/`trigger_comment_id`), `/active-task`,
`/usage`, `/comments`, `GET /api/tasks/{id}/messages`,
`GET /api/agent-task-snapshot`, `GET /api/runtimes`. Task state strings:
`queued | dispatched | running | waiting_local_directory | deferred |
completed | failed | cancelled`. Sufficient for reconciliation-as-truth.

### P14 — WebSocket
`GET /ws?workspace_id=…`, auth by first frame
`{"type":"auth","payload":{"token":"mul_…"}}` → `auth_ack`. Captured during
P3: `task:queued → task:dispatch → task:running → task:progress ×2 →
task:message ×28 → task:completed`, plus `issue:created/updated`,
`comment:created`, `agent:status`, `subscriber:added`, `activity:created`,
`inbox:new`. Workspace room carries all task/comment events (per-task scoping
exists server-side but is disabled) — one connection suffices.

### P15 — Agent/squad management
All via API: `POST /api/agents` (needs an **existing** `runtime_id` — agents
can only be created after a daemon has registered), `PUT /api/agents/{id}`
(model/thinking/runtime rebind), per-agent env via create-time `custom_env`,
`POST /api/squads` (leader auto-membered), `POST /api/squads/{id}/members`
with `{"member_type":"agent","member_id":…}`, member list/roles. Squad-based
idle-pool management for M3 team evolution is API-feasible; no fallback
needed on this evidence.

## Design consequences (feed into M1b/M2)

1. **SHA over branch, everywhere.** Branch names are per-task and unstable
   across daemon restarts (P7). Contract validation and merges must key on the
   `commitSha` from task results — already the D6 design; now evidence-backed.
2. **Conductor must own runtime-binding repair.** Container recreation orphans
   agents on dead runtime rows and strands tasks in `queued` silently (P9b).
   Reconciliation needs a per-state liveness timeout on `queued` and a repair
   sequence: rebind agent → cancel stranded task → rerun.
3. **Cancel on key exhaustion.** Budget-capped tasks linger `running` in
   retry backoff for minutes before failing (P10). The M2b watchdog should
   cancel the task when it revokes/expires a key, not wait.
4. **LiteLLM is the budget/spend source of truth** (P11): Multica usage is
   zero for failed tasks and uncosted for gateway aliases. Guild reads spend
   from the gateway; Multica's numbers are advisory display data.
5. **The daemon container is the sandbox** (P3): agents run with
   `--permission-mode bypassPermissions`. Tier 1's security floor statement
   stands; never run the daemon image outside a container.

## Addendum 2026-07-30 — P16: OpenCode e2e (gates the D9 default flip)

Same stack, daemon image rebuilt with OpenCode `1.18.10` added (pinned build
arg; autoupdate disabled in the baked `opencode.json`, which declares the
LiteLLM gateway as a custom `litellm` provider with
`{env:GUILD_DAEMON_VIRTUAL_KEY}`).

| # | Probe | Verdict |
|---|-------|---------|
| P16 | OpenCode e2e: registers as its own runtime, claims + completes a task via the gateway, pushes engagement branch | **PASS** |

- Recreated daemon registered **two** runtime rows from one container —
  `Opencode (guild-daemon-1)` and `Claude (guild-daemon-1)` — confirming
  one-row-per-CLI multi-runtime registration live (previously source-only).
- Agent `probe-opencode` with model `litellm/or-claude-haiku-4-5`
  (`provider/model`-qualified, as OpenCode requires): task `555f8277`
  completed in ~40s; branch `agent/probe-opencode/555f8277` pushed;
  `OPENCODE.md` content byte-exact.
- Metering intact: spend landed on the same LiteLLM virtual key; Multica
  usage recorded (17,434 in / 1,226 out, `task_count` 1).
- Recreate-orphaning behaved exactly as P9b documented (old runtime rows
  lingered online through the heartbeat window; old agents orphaned — dev
  stack accepts this; conductor repair sequence unchanged).

## Addendum 2026-07-31 — P12b: extended thinking root cause (closes the P12 UNCONFIRMED)

Verdict revision: extended thinking **PASS-WITH-WORKAROUND** (was
UNCONFIRMED). The `--effort` flag injection works; it is gated on the model
id, and gateway aliases fail that gate silently.

Root cause (source, v0.4.15): the daemon validates `thinking_level` against
a **hard-coded static Claude model catalog** before spawning
(`server/pkg/agent/models.go` `claudeStaticModels()`;
`server/internal/daemon/daemon.go` calls `ValidateThinkingLevel` and on a
failed lookup logs `thinking_level: not valid for this (provider, model);
skipping injection` and drops the level — the task still runs). Any model id
absent from that static list fails closed: every gateway alias
(`or-claude-haiku-4-5`), and even the undated real id `claude-haiku-4-5`
(the catalog's only Haiku entry is the dated `claude-haiku-4-5-20251001`).

Live proof, both directions (daemon log, task spawn args):

| Agent model | Warning fired | `--effort` in spawn args |
|---|---|---|
| `or-claude-haiku-4-5` | yes | no |
| `claude-haiku-4-5` | yes | no |
| `claude-haiku-4-5-20251001` | no | **yes** (`--effort high`) |

Workaround for gateway-routed Claude Code agents: **name the LiteLLM alias
exactly after a static-catalog model id** (e.g. define gateway model
`claude-haiku-4-5-20251001` routed to the OpenRouter backend) — the daemon
then injects `--effort` and the traffic still flows through the metered
gateway. OpenCode agents are unaffected by this path (their thinking uses
OpenCode variant discovery, a different mechanism). Consequence recorded for
D2's acceptance item; the conformance suite pins the static-catalog gate so
a pin bump that changes the catalog surfaces as a test failure.

New substrate facts found while probing (M1b adapter work, same day):
issue create 409s on same-title *active* issues unless `allow_duplicate`
is set (code `active_duplicate_issue`); issue `metadata` is accepted but
**not persisted** by POST /api/issues; issue updates are PUT (PATCH → 405);
`/auth/send-code` has a request cooldown (429 "please wait before
requesting another code"); a completed reply-style OpenCode run can carry
`result.output: ""` with `models_with_usage=1` (silent completion — the
work report, not the summary text, is the reliable signal).

**Correction (2026-07-31, later the same day):** the paragraph above ends
with "the conformance suite pins the static-catalog gate so a pin bump …
surfaces as a test failure" — overclaimed. No conformance assertion covers
the thinking gate today; the suite pins status mapping/ordering, cancel
semantics, dispatch idempotency, and error classification. A
thinking-injection assertion remains **open work for the next pin bump**.
Two more facts from the same day's smoke work: agent env updates moved to
`PUT /api/agents/{id}/env` (`{"custom_env": …}`, member token only — the
agent-update PUT rejects `custom_env` in v0.4.15), and per-engagement key
attribution via agent-level `custom_env.GUILD_DAEMON_VIRTUAL_KEY` is
**proven for OpenCode agents** (spend landed on the injected key; note
LiteLLM's ~60s spend-write batching when reading it back).

## Addendum 2026-08-02 — model capability floor for push-required work

Observed live during M1b smoke bring-up (2026-07-31), recorded here as
durable evidence: `or-gemini-flash-lite` (OpenCode runtime) **"completes"
push-required engagements without doing the work** — task reports
`completed` in ~8s with `tools=1`, `models_with_usage=1`, empty
`result.output`, and no branch pushed. The daemon treats a clean agent exit
as completion; nothing substrate-side distinguishes hollow completions —
which is exactly the gap contract validation exists to close, and the smoke's
branch-resolution step caught it. **`or-deepseek-v3-2` is the cheapest tier
model that reliably executes the clone→edit→commit→push flow** (three
consecutive green smoke runs). Consequence: reply-only probes (conformance
suite) stay on `or-gemini-flash-lite`; anything whose acceptance requires a
pushed branch uses `or-deepseek-v3-2` or better (`GUILD_SMOKE_MODEL`
overrides the smoke worker).

## Addendum 2026-08-02 — P17–P22: multi-project, workstream grouping, and board-as-control-surface probes

Run live against the guild-dev stack (Multica v0.4.15, daemon up 2 days, no
restarts needed). Probes defined in issues #5 (P17/P18), #8 (P19), #10
(P20–P22); operator decisions of 2026-08-02 (workspace-per-project, six-lane
board, idea-as-ticket) recorded on those issues were made *before* these
results and are all confirmed or strengthened by them.

### P17 — daemon multi-workspace registration + service: PASS

Created a second workspace via `POST /api/workspaces` (**both `name` and
`slug` required** — `{"error":"name and slug are required"}`; creation is
fully API-automatable). The running daemon's runtime rows (`Claude
(guild-daemon-1)`, `Opencode (guild-daemon-1)`) appeared **online in the new
workspace immediately, with no daemon restart** — the daemon container has no
workspace-binding env var (`MULTICA_DAEMON_TOKEN` + `MULTICA_SERVER_URL` only),
so the `mdt_` token is user-scoped and runtimes project into every workspace
of the owning user, including ones created after daemon start. Service
proven, not just registration: an agent created in workspace 2 on its
Opencode runtime row (`or-gemini-flash-lite`, reply-only) received a
dispatched task and ran it to `completed`. **Consequence for #5: mapping A
(workspace-per-project) runs on ONE daemon container; the daemon-per-project
fallback is not needed for reachability** (it remains available for
throughput/isolation reasons only). Runtime row ids differ per workspace for
the same physical daemon — agents bind to the row in their own workspace.

### P18 — per-project repo scoping inside a workspace: FAIL (settles mapping B)

`/api/projects` exists (`GET` paginated `{projects,total}`; `POST` requires
`title`). A project is a **delivery grouping only**: `{id, workspace_id,
title, description, icon, status: "planned", priority, lead_type/lead_id,
start_date, due_date, issue_count, done_count, resource_count}`. **No repo
surface**: `GET /api/projects/{id}/repos` → 404, and `PUT` with a `repos`
array returns 200 with the field silently dropped. Repo wiring remains
workspace-level only (`workspace.repos`). Issue↔project attachment works both
ways (`project_id` on create — validated: a foreign id gets 400 `"project not
found in this workspace"` — and `PUT /api/issues/{id} {project_id}`).
**Mapping B (projects-in-one-workspace) is dead for Guild-project isolation,
as the 2026-08-02 decision assumed; mapping A confirmed by evidence.**

### P19 — parent_issue_id: PASS (dispatch-neutral)

`parent_issue_id` is a first-class issue field: accepted on `POST
/api/issues`, persists, round-trips on `GET`, and appears in list responses
and `issue:updated` WS payloads. A child issue assigned to an agent
dispatched and completed normally — **no effect on task dispatch**. Task
completion did **not** auto-change issue status (stayed `todo` through
`task:completed` — P6's advisory-status finding extends to completion:
nothing substrate-side fights a conductor-owned lane projection). For the #8
workstream umbrella there are now TWO proven grouping surfaces:
`parent_issue_id` (hierarchy) and `project_id` (a grouping entity with
`issue_count`/`done_count` rollups — a natural workstream candidate).
Remaining sliver: board *UI rendering* of parent/child was not visually
verified (API-level only).

### P20 — lane definability: fixed enum, clean 1:1 mapping (PASS-WITH-MAPPING)

Issue statuses are a server-enforced **fixed 7-value enum** — `PUT` with an
unknown value returns 400 `invalid status "…"; valid values: backlog, todo,
in_progress, in_review, done, blocked, cancelled`. No status/board/column
config surface exists (`/api/statuses`, `/api/boards`, `/api/columns` → 404).
Custom lanes are impossible, but the decided six-lane model maps 1:1 with a
value to spare: Backlog→`backlog`, Ready to work→`todo`, In
progress→`in_progress`, Waiting for feedback→`blocked`, Ready for
testing→`in_review`, Done→`done`, and `cancelled` covers the terminal
Cancelled exit. This is exactly the #10 fallback (deterministic mapping), with
zero projection ambiguity.

### P21 — status-change WS frames: PASS

The M1a frame catalog (`task:*`, `comment:created`) was incomplete. Newly
observed on the workspace socket: **`issue:updated`** fires on every issue
mutation carrying the full issue object plus `prev_*` values and per-field
booleans (`status_changed`, `assignee_changed`, `description_changed`, …);
**`activity:created`** fires alongside with a semantic audit entry
(`action: "status_changed"`, `details: {from, to}`). Also catalogued:
`agent:status` (full agent row incl. `has_custom_env`/`custom_env_key_count`),
`task:message` (live seq'd tool-call/text stream of a running task),
`inbox:new` (operator inbox items), `subscriber:added`, `auth_ack`. Guild's
watcher gets push for every lane move; polling remains reconnect-gap
reconciliation only.

### P22 — actor attribution: PASS

Every `activity:created` entry carries `actor_id` + `actor_type` (observed:
`"member"` for PAT-driven changes, `"agent"` for agent-driven ones — e.g.
`task_completed`); comments carry `author_type`/`author_id`
(+`source_task_id` when task-authored); issues carry
`creator_type`/`creator_id`. Human-vs-agent disambiguation is therefore
first-class. **Design consequence for #10: mint the Guild conductor its own
member identity (own PAT)** so human-vs-Guild moves are distinguished by
`actor_id`; the idempotent-echo fallback stays as belt-and-braces only.

Probe artifacts left on the dev stack (evidence, safe to delete): issues
GUI-70/71 + one in workspace 2, project `guild-probe-p18`, workspace `Guild
Probe 2` (`619a5b5c`), agent `guild-conf-ws2`; `guild-conf`'s `custom_env`
was cleared (the testkit re-applies it every smoke run by design).

## Addendum 2026-08-03 — P23: workspace membership, and the M2a live facts

Probed while building the M2a acceptance (all against the live guild-dev
stack, v0.4.15).

### P23 — second-member flow: PASS (the D11 conductor identity is real)

`POST /api/workspaces/{id}/members {email, role}` (201) mints a **pending
invitation** (the `/invitations` GETs exist on both flat and workspace
paths; their POSTs are 405 — members POST is the creation route). The
invitee authenticates (dev-code flow works for any email), sees the
invitation on `GET /api/invitations`, and joins via
`POST /api/invitations/{id}/accept`. Role facts: **the member-row update
PUT is 405 — a role change is remove (`DELETE
/api/workspaces/{id}/members/{rowId}`, 204) + re-invite**. Capability
facts: a plain `member` sees the owner's runtime rows but **cannot create
agents on a private runtime** (403 `"only its owner or a workspace admin"`)
and sees an empty agent list for the owner's private agents; an **`admin`
member can create agents on the owner's runtime and drive their env
endpoint** — both live-proven. Consequence: the conductor runs as its own
**admin** member (D11), giving first-class human-vs-Guild actor attribution
with zero API gaps; M3 hiring gets the same surface.

### Instructed-idle first attempt: deepseek obeys instructions over visible checks

With the full contract checks visible in the brief (D6 renders them), an
explicit numbered instruction — "iteration 1: reply ACK only, do NOT
create/modify files, do NOT run git" — was followed literally by
`or-deepseek-v3-2`: task `completed`, **no branch pushed** (ls-remote
empty). This makes a *genuine* hollow completion (the multica#1579 class)
deterministically constructible for acceptance fixtures, and reconfirms
the model-floor observation that instruction-following, not capability,
governs what cheap models do.

### M2a acceptance facts (2026-08-03, twice green: 2m55s / 3m45s)

- A conductor-authored top-level rework comment (P5 was operator-PAT)
  **triggers the implementing agent's session resume** — the bounce path
  works across member identities.
- On session-resumed rework the daemon *does* mint a fresh per-task branch;
  resolution against every branch hint the engagement ever named (the
  conductor remembers them) found the rework push.
- `git push <sha>:refs/heads/<target>` against GitHub enforces
  fast-forward-only exactly as the D6 merge rule requires; a full
  `--no-checkout` clone suffices to make the pushed sha local.
- The guild Postgres is published **loopback-only** (127.0.0.1:5442) for
  the host-side conductor of the M1–M2a dev era — a documented deviation
  from the databases-internal floor, dropped when the conductor ships as a
  compose service (M2b).
