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

## Addendum 2026-08-03 — P24/P25: issue-creation events and creator attribution (M2b idea detection)

Probes run live against the same v0.4.15 stack before the M2b planner
depends on them (script: session-local; artifacts GUI-89–GUI-92 created
and cancelled off-board same-day).

### P24 — issue-creation WS frames: PASS

Creating an issue over REST pushes, on the authenticated workspace
socket (auth is a post-open frame `{type:"auth",payload:{token}}` —
an unauthenticated socket connects but receives **nothing**):

- **`issue:created`** carrying the FULL issue object (title,
  `description`, `status`, `creator_type`/`creator_id`) in
  `payload.issue`, plus top-level `actor_id`/`actor_type` on the frame
  itself — live idea detection needs no follow-up read;
- **`activity:created`** with `entry.action: "created"` and the same
  actor attribution — the audit-trail source, same shape P21/P22
  catalogued for `status_changed`;
- `subscriber:added` (reason `creator`) — noise, ignorable.

New issues default to **status `todo`** (the ready-to-work lane), not
`backlog` — an operator-authored idea ticket arrives in a go lane and
the conductor must not read that as a dispatch signal for anything
(idea tickets carry no engagement marker; D11's marker discipline is
the guard, not the lane).

### P25 — issue creator + body surfaces: PASS (one id space everywhere)

- Issue rows carry `creator_type` ("member") + `creator_id`
  first-class, on POST echo, `GET /api/issues/{id}`, AND the list
  endpoint — reconcile-based idea detection works from reads alone.
- `description` rides in full on all three surfaces — the planner can
  (re-)read the idea body without any new endpoint.
- **Id space is uniform**: issue `creator_id` == `/api/me` `.id` ==
  activity `actor_id` (verified for both the operator and conductor
  identities). The existing `selfMemberId` comparison attributes
  creators exactly as it attributes lane moves. (The workspace
  members-list row ids are a DIFFERENT space — never compare against
  those.)
- `GET /api/issues/{id}/activities` is 404 — no REST read for the
  activity trail; activities are WS-only, reads-as-truth stays on the
  issue/list surfaces.

Per-attempt signal for rework detection (#11 double-hollow): no new
probe needed — task-run ids are already read (P13,
`GET /api/issues/{id}/task-runs`) and the snapshot derivation already
selects `latestCompleted.id`; exposing it as the report's attempt id is
adapter work, not a capability question.

### Invitation crash-recovery surfaces (closes the #11 ensureWorkspaceMember unknowns)

- A duplicate member invite **409s** (`"invitation already pending for
  this email"`) — it never duplicates.
- Pending invitations are listable **owner-side** at
  `GET /api/workspaces/{id}/invitations` (bare array with
  `invitee_email`, `role`, `status: "pending"`, `expires_at` +7 days);
  the invitee-side `GET /api/invitations` view exists too. A run that
  crashed between invite and accept is adoptable from either side.
- `DELETE /api/invitations/{id}` is **405** — pending invitations
  cannot be revoked; they expire after 7 days. (One probe leftover for
  watchdog@guild.local expires 2026-08-10 — harmless.)

## Addendum 2026-08-03 (later) — M2b live facts

Found while driving the M2b acceptance (five-stage demo pipeline, four
role agents, real gates on the live stack); each fact is now load-bearing
in code or harness.

- **Stage economics (opencode + or-deepseek-v3-2):** a stage session
  costs ~10–25¢ (measured across one green run: analysis 19¢,
  architecture 10¢, implementation 11¢, test 19¢, delivery 18¢ — 77¢
  for the whole five-stage delivery). A $1.00 plan starves its stages:
  the first live run's architecture engagement hit its 15¢ key cap and
  the gateway hard-stopped serving at $0.1506 (+0.4% overshoot — the
  D2 insurance layer behaving exactly as its M1a evidence predicted).
  The demo plan ships at $3.00.
- **Key revocation deletes spend readback.** `/key/delete` removes the
  key AND its `/key/info` spend surface — a terminated engagement's
  spend becomes unreadable. Consequence (now normative in the
  conductor): every termination captures the final gateway reading
  into its trail entry BEFORE revoking; project accounting sums live
  keys plus terminated recordings.
- **Issue status ≠ task lifecycle, in BOTH directions.** P19 showed
  task completion never moves issue status; the converse also holds:
  setting an issue to `cancelled` does NOT kill its running task —
  only `POST /api/tasks/{id}/cancel` does (the adapter's `cancel()`
  has always done this; manual board hygiene must too, or the agent
  grinds on against a capped key in retry backoff, P10).
- **Issue listing is paginated** — a naive single-page
  `GET /api/issues` silently misses old rows (four ancient probe
  tickets got adopted as ideas through exactly this gap in a harness
  sweep). The adapter's self-consistent paginated sweep (M1b verify
  hardening) is the only trusted board read.
- **Driver-environment color leak:** harnesses exporting `FORCE_COLOR`
  make spawned Node CLIs ANSI-wrap `console.log` output, breaking
  string assertions that pass in the (neutral-env) validator sandbox.
  Acceptance asserts run under a scrubbed env.
- **The whole D11/D12 grammar is live-proven:** operator ticket →
  deterministic plan answer; `amend:` comment → superseded v1, re-gated
  v2 (repriced); five sequential stage gates each opened only after the
  prior acceptance, with the upstream handoff read from the validated
  SHA; and the watchdog hard-cap halt cancels in-flight work, locks
  dispatch, and explains itself on the idea ticket.

## Addendum 2026-08-05 — P26–P29: the D15 attribution probe (REST activity trail, ordering, and lane authority)

Run against the live guild-dev v0.4.15 stack (backend commit
`a9a4a3d638e5`), mutating only the throwaway issue
`ffd77018-a19d-44c2-99bb-cd331923091b` (GUI-12), cancelled during
cleanup. Four analysis lenses plus three adversarial refutation
passes; where a lens and a refuter disagreed the refuter's evidence
governs, except at the two points below where counter-evidence is
quoted inline.

### P26 — REST activity trail: PASS (`/timeline` exists; supersedes one P25 inference)

`GET /api/issues/{id}/timeline` returns `HTTP 200`,
`content-type: application/json`, a bare JSON array ordered ascending.
Entries are a TAGGED UNION and only one arm has the shape P22
catalogued:

- `type: "activity"` — `{type, id, actor_type, actor_id, created_at,
  action, details}`; actions observed `created`, `status_changed`,
  `description_updated`, `assignee_changed`, `task_completed`,
  `task_failed`. `status_changed` always carries both keys
  (`{"to": "done", "from": "in_progress"}`) — 0 missing `from`, 0
  missing `to` across every row inspected, on this issue and workspace-
  wide.
- `type: "comment"` — `{type, id, actor_type, actor_id, created_at,
  content, updated_at, comment_type}` (+`source_task_id`, `parent_id`
  when present). It carries **no `action` and no `details`**. A consumer
  reading `e.action` on a comment gets `undefined`; filter on `type`
  first.

Shape is not stable under query params. A **non-empty** `limit`,
`before`, or `after` switches the body to
`{entries, next_cursor, prev_cursor, has_more_before, has_more_after}`
**and reverses the order to descending**; `?limit=` (empty),
`?direction=…`, `?type=…`, `?cursor=…`, `?page=…`, `?offset=…` all
leave the bare ascending array. An adapter must call the bare path and
never pass pagination params.

Authz is clean for the reconcile identity: the conductor PAT gets
`HTTP 200` on every issue in its workspace, including issues it did not
create and issues assigned to agents. No `x-workspace-id` → `HTTP 400`
`{"error":"workspace_id or workspace_slug is required"}`; foreign
workspace → `404`; no auth → `401`. It is a genuine backend route, not a
frontend-proxy artifact — byte-identical responses from
`localhost:3000`, from `localhost:8080`, and from inside
`guild-dev-multica-backend-1` against `127.0.0.1:8080`.

**This supersedes the last bullet of P25, and only that bullet.** P25's
observation stands and still reproduces exactly: `GET
/api/issues/{id}/activities` is `404` (re-tested this session against
both the proxy and the backend, along with `/activity`, `/history`,
`/events`, `/audit`, `/log`, `/changes` — all `404` on both). What is
superseded is the inference drawn from it — *"no REST read for the
activity trail; activities are WS-only, reads-as-truth stays on the
issue/list surfaces"*. A REST read does exist; that path was never
tried. P25's other four bullets were re-checked and are unaffected.

### P27 — timeline ordering and completeness: FAIL (cannot answer "who moved this lane last")

The array is not scrambled — it is deterministically sorted by
`(created_at ASC, id ASC)`, verified directly (returned order ==
`sorted(entries, key=(created_at, id))` → `True`; reverse → `False`).
The failure is that neither key discriminates:

- `created_at` is **second-resolution** in JSON
  (`"2026-08-05T21:29:07Z"`) while Postgres holds microseconds
  (`21:29:07.693956+00`).
- Entry `id` is **UUIDv4** — version nibble `4` on 205/205 ids
  inspected — not the UUIDv7 Multica uses for daemon ids. There is no
  time-sortable tiebreak anywhere in the response.

So intra-second order is a uniform random permutation of the true
order. Measured across passes: 23 controlled six-move bursts put the
operator's entry in its true position 4/23 (~1/6) and last 5/23
(chi-square 2.83 on 5 df — indistinguishable from uniform); six further
independent bursts returned it at positions 1,1,5,5,3,2 against a true
position of 3,2,2,2,2,2. This is not a synthetic artifact: the organic
board already holds six seconds containing an operator move and a
conductor move (the plan-approval gesture pair), of which two are
returned inverted.

The loss happens **above** the query layer, which matters for the fix
direction: the server's own SQL keeps full precision —

```
-- name: ListActivitiesForIssue :many
SELECT id, workspace_id, issue_id, actor_type, actor_id, action,
       details, created_at FROM activity_log
WHERE issue_id = $1
ORDER BY created_at ASC, id ASC
LIMIT $2
```

— and the serializer emits second-resolution RFC3339. Record this as
"Multica discards an order it already has" (a cheap upstream fix), not
as a data-model limit.

That same SQL is also the completeness defect: `ORDER BY … ASC LIMIT
$2` keeps the **oldest** rows and silently drops the **newest**, which
is the opposite of what a truncation is normally assumed to do. The
bound is server-fixed, not caller-supplied — every `limit` value
returns the identical row set, with `has_more_after: false` and
`next_cursor: null` asserting completeness. Migration
`068_timeline_keyset_index.up.sql` and the symbol
`handler.timelinePaginatedResponse` show keyset paging is half-wired
but externally non-functional in v0.4.15. An earlier pass measured the
cap at 2000 and demonstrated three fresh status changes invisible while
the endpoint reported a five-minute-stale entry; **that number could not
be re-verified here** — the flood rows have since been deleted and the
issue now holds 205 entries, below any truncation. Treat the cap as
mechanism-confirmed, value-unconfirmed.

Net capability: a `getLaneAttribution(issueId)` built on this endpoint
can return the SET of actors who made a `to === <target>` move at or
after an inclusive second-resolution watermark, a truncation flag
(activity-typed entries === the cap), and an ambiguity flag (newest
shared second holds more than one distinct actor). It can **never**
return "the most recent mover". Any rule of the form "last mover wins"
is a lottery an adversary can buy tickets in.

### P28 — write-side actor attribution: PASS-WITH-CAVEAT (no escalation; a validated agent override does exist)

Header and body actor spoofing is ignored, in **both** directions —
this is the security-relevant half and it holds. `X-Actor-Source`,
`X-User-ID`, `X-Actor-Type`, `X-Actor-Id`, `X-On-Behalf-Of` and body
`actor_id`/`actor_type` never move attribution: the daemon PAT cannot
forge the conductor, and the conductor PAT cannot forge the operator.

But attribution is **not** purely bearer-derived, and the earlier
formulation of that claim was too strong. `X-Agent-ID` **and**
`X-Task-ID` together do move attribution, into the agent id space.
Verified live: a conductor-PAT `PUT /api/issues/{id}` carrying a matched
pair produced `agent | f88cbbf9-… | {"to": "in_review", "from":
"done"}`, while the identical PUT without the headers produced `member |
3b2efd78-…`. Both headers are required and both are validated — the
backend binary carries `resolveActor: X-Agent-ID present but X-Task-ID
missing, refusing to trust agent identity`, `resolveActor: X-Agent-ID
rejected, agent not found or workspace mismatch`, and `resolveActor:
X-Task-ID rejected, task not found or agent mismatch`. The shipped CLI
at `/usr/local/bin/multica` contains both header names; this is the
mechanism behind P22's agent-attributed rows.

Re-verified independently after synthesis, on a second agent/task pair
(`5b95511c-…` / `6a42928e-…`, matched from `agent_task_queue`): the
matched pair yielded `agent | 5b95511c-… | {"to": "in_review", "from":
"done"}`, and `X-Agent-ID` **alone** — no `X-Task-ID` — fell back to
`member | 3b2efd78-…`, confirming both headers are required.

The override reaches only `actor_type: "agent"` with an `actor_id` from
the **agent table** — a different id space from members (P25's warning,
in a new guise). There is no path to another member, so the escalating
direction stays closed and the D15 concern is unaffected. The
exploitable direction is a downgrade: a member-PAT holder laundering
their own write into agent attribution, which under Guild's semantics
makes the move *ignored*, not *trusted*.

Consequence to carry forward: `actor_type` is **not** proof of who
acted. It proves only that the actor is not a member other than the
token's owner. Written unqualified ("attribution is server-derived from
the bearer token") it is the same species of over-generalization as
P25's superseded clause.

### P29 — issue-status authority by actor type: FAIL (there is no ceiling)

D15's reachability caveat asked whether Multica lets an agent change
issue status. Before this probe the whole `activity_log` held exactly
five agent-attributed `status_changed` rows, all `to: in_review`, across
five distinct issues — read by two lenses as evidence that agents stop
at `in_review` (Guild lane `ready_for_testing`), and therefore that
A5c/A5d might be unreachable.

That reading is wrong. `in_review` is where Multica's own agent brief
*asks* agents to stop ("run `multica issue status %s in_review` to mark
the parent ready for review"), not where the server stops them. Using
the P28 override, an agent-attributed move to `done` was accepted:
`HTTP 200`, the issue's `status` became `done`, and the row is `agent |
f88cbbf9-… | {"to": "done", "from": "in_progress"}` — reproduced
independently on the second pair as `agent | 5b95511c-… | {"to":
"done", "from": "in_review"}`. No authorization
check on target status by actor type exists — searches of `/app/server`
for per-actor-type status restrictions return nothing, and the only
status-authority restriction present concerns squad guests.

Scope this precisely. Authorization for the write came from a member
PAT; the override supplied only attribution. Whether a task-scoped
`mat_` token is itself authorized to call `PUT /api/issues/{id}` remains
**UNVERIFIED** — no pass obtained one. What is proven is narrower and
sufficient for D15: the issue-status write path applies no
actor-type-conditioned restriction on the target status, so an
`agent`-attributed `done` is producible and accepted. The counted
"five agent moves, all `in_review`" is a convention artifact, not a
ceiling; it now reads six, plus one `done`, and both additions are this
probe's.

Direct D15 consequence: reconcile's forward transitions read
`snap.lane` only (`conductor.ts:1033` gate approval, `:1087` accept), so
A5c does not require the operator-identity forgery at all. Any writer
who can set the lane reaches it, whatever the attribution says.

### Deployment fact — `MULTICA_DAEMON_TOKEN` resolves to the operator

Three distinct 44-char `mul_` PATs, two identities. `GUILD_OPERATOR_TOKEN`
and `MULTICA_DAEMON_TOKEN` are different strings (compared by digest, not
disclosed) that both resolve via `GET /api/me` to `3ed88a91-…` /
`operator@guild.local`; `GUILD_MULTICA_TOKEN` resolves to `3b2efd78-…` /
`conductor@guild.local`. This is the shipped arrangement, not a dev
artifact: the base `deploy/compose/docker-compose.yml` injects
`MULTICA_DAEMON_TOKEN` into `guild-daemon`, there are no Kubernetes
manifests in the repo, and the quickstart (`deploy/compose/README.md`
step 3) instructs the human to mint the PAT from their own account —
the only human account being the operator. `actorFrom`
(`translation.ts:71`) maps every non-conductor member to `operator`, so
a board move authored with that credential is read by Guild as an
operator move and satisfies `conductor.ts:517`.

The credential is agent-reachable by design, in three places: the
daemon's environment; `/proc/7/environ` (readable by uid 1001 — the
same uid agent subprocesses run as — and the daemon holds zero
capabilities, so it cannot fork a child under any other uid); and
`/home/agent/.multica/config.json` (mode 0600, owner `agent`), written
by `docker/daemon/entrypoint.sh:26`. Multica's one guard is cwd-scoped:
inside the task workdir the CLI refuses the ambient PAT (`agent
execution context requires MULTICA_TOKEN to be a task-scoped mat_
token`), but one `cd` restores it, and it gates the CLI, not the
credential.

**Scope this honestly — most of it is already conceded.**
`deploy/README.md` states Tier 1 does not provide "egress control (a
prompt-injected agent can send anything it can read — including its git
token and Multica daemon token — to any host on the internet, and can
push to any repo its git token reaches)". Verified here: the daemon
container's `GITHUB_TOKEN` and the PAT embedded in the conductor's
`GUILD_REPO_URL` are the **same** 40-char credential (compared by digest,
not disclosed), and `GUILD_TARGET_BRANCH` defaults to `main`. Agent code
therefore already holds direct push to the acceptance target, and a
forged acceptance — which only fast-forwards a *conductor-chosen*
`validatedSha` — adds no code-integrity capability. What the forgery
does add is two things the git token does not: (i) false operator
attribution in Guild's governance trail, and (ii) via the forged gate
approval at `conductor.ts:519-521` → `approveStage` → `dispatch`, spend
the agent cannot otherwise cause — defeating a stated blast-radius
bound, "plans require explicit approval before any spend"
(`deploy/README.md`).

### Hardening drift (adjacent; changes no verdict above)

`docs/ARCHITECTURE.md` and `deploy/README.md` both state the compose-era
floor includes "`cap_drop: ALL` + `no-new-privileges`, and memory/pids
limits on daemon and validator containers". Live, the daemon has none of
them: `docker inspect guild-dev-guild-daemon-1` → `User=agent
CapDrop=[] SecOpt=[] Pids=<nil> Mem=0`, while the conductor block
carries `security_opt: [no-new-privileges:true]` and `cap_drop: [ALL]`.
The `guild-daemon` service block in
`deploy/compose/docker-compose.yml` simply omits the stanza; non-root
does hold. This changes nothing above — `CapEff` is already `0` for a
non-root process and `cap_drop` would not close a same-uid read — but a
normative security claim is materially unmet on the one container that
runs LLM-generated code.

## Addendum 2026-08-06 — P30: daemon-identity partitioning viability (D15 Option 4 part a)

Before implementing D15 Option 4 part (a) — giving the daemon its own
`daemon@guild.local` Multica member identity so no agent-reachable credential
resolves to `operator` — the record listed two handler-level behaviours as
"answered in Option 4's favour from server SQL, untested at the handler; verify
during implementation": whether a plain-member daemon's runtime rows project
into the operator's workspace, and whether an admin can create agents on that
runtime. Verified against the live `guild-dev` v0.4.15 Multica Postgres
(read-only inspection; no mutations).

### P30 — runtime/agent ownership is workspace-scoped, not owner-pinned: PASS (part a is viable)

Schema: both `agent_runtime` and `agent` carry `workspace_id`, `owner_id`, and
`visibility` as independent columns; `agent.runtime_id` binds an agent to a
specific runtime row; `agent_task_queue` rows also pin `runtime_id`.

Live wiring in the operator's project workspace (identities referenced by role;
the id↔role map is the deployment's own, not reproduced here):

- **Claim 2 — CONFIRMED.** The four role agents (`guild-analyst/architect/
  implementer/tester`) are owned by the **conductor** member and bound to a
  runtime owned by the **operator** member (a *different* member), and
  `agent_task_queue` shows tasks that **completed** on that cross-owned runtime.
  An admin creating agents on, and dispatching to, a runtime owned by another
  member is therefore the live reality — so a separate `daemon@guild.local`
  identity's runtime can host conductor-created agents exactly as the
  operator-owned one does today.
- **Claim 1 — SUPPORTED.** Runtimes are `workspace_id`-scoped with `owner_id`
  orthogonal (schema + the cross-owner binding above). A daemon configured for
  the operator's workspace registers its runtime there independent of which
  member it authenticates as; changing that member changes only `owner_id`, a
  column nothing in the agent→runtime→task binding path keys on.

**Residual (not a blocker; pre-existing, unrelated to identity separation).**
The dev daemon's `daemon_id` is a per-container UUID with no volume, so each
container start inserts a *new* `agent_runtime` row and the role agents remain
pinned to the prior runtime (observed live: agents bound to an `offline`
runtime while a newer runtime is `online`). This daemon-id churn — not identity
separation — is what orphans agents across a restart. Consequence for the part
(a) migration: existing installs re-minting the daemon token under the new
identity keep their agent bindings **only if `daemon_id` is stable** (a
persistent `~/.multica/daemon.id`); otherwise re-run `guild init` to re-bind.
Fresh installs are unaffected. End-to-end confirmation (a daemon actually
running as `daemon@guild.local` and dispatching a task) is a deployment-time
step, performed when the stack is rebuilt to mirror `main` after the fix
merges — not exercised here to avoid mutating the running dev daemon.
## Addendum 2026-08-13 — P17 re-run under the D15 identity split: membership-gated runtime projection

Re-ran P17/P18 on the live stack (Multica v0.4.15) after D15 moved the daemon
to its own non-owner identity (`daemon@guild.local`). One real mechanics
delta, one reaffirmation:

### P17 delta — projection is membership-gated now (still PASS, one daemon serves N workspaces)

The 2026-08-02 result ("runtime rows project into every workspace of the
owning user, immediately, no restart") described the pre-D15 world where the
daemon token WAS the workspace-owning operator. Under D15 the daemon user is
not the creator of new workspaces, and projection follows **membership**:

- A freshly created workspace (`POST /api/workspaces`, operator-owned) showed
  **no** daemon runtime row while the daemon user was not a member.
- Membership needs the invitation handshake (as recorded in the 2026-08-03
  P23 addendum): operator `POST /api/workspaces/{id}/members {email, role}`
  mints a *pending* invitation (`user_id` alone is rejected — "email is
  required"); the daemon token lists it (`GET /api/invitations`) and joins via
  `POST /api/invitations/{id}/accept`. Both calls are API-automatable with
  tokens `guild init` already holds.
- **The instant the acceptance landed, a NEW, distinct runtime row appeared
  online in the second workspace — no daemon restart** (row ids differ per
  workspace for the same physical daemon, as in the 2026-08-02 run; the
  original workspace's row stayed online and its agent bindings untouched).
- Service proven end-to-end again: an agent created in workspace 2 on that
  row (`or-deepseek-v3-2`) picked up a dispatched issue and pushed the
  contracted branch (`probe/p17` on the scratch repo) to completion.

Consequence for #5/D10 unchanged in substance, sharper in mechanics: mapping
A still runs on ONE daemon container, but multi-project provisioning must
drive the invite/accept handshake per new workspace — "serves every workspace
of its owner" is now precisely "serves every workspace of which its user is a
member".

### P18 — reaffirmed (unchanged verdict)

The project entity still carries no repo surface: no `repos` field on the
entity, `PUT` with a `repos` array returns 200 with the field silently
dropped, `GET /api/projects/{id}/repos` → 404 (and `PATCH` on the entity is
405 — `PUT` is the update verb). Repo wiring remains workspace-level only;
mapping B stays dead for repo isolation.

## Addendum 2026-08-17 — cheap-tier re-validation (PR #67 bake-off)

Operator directive: setup/smoke flows must run far below the
`or-deepseek-v3-2` tier ($1.37 avg per m2b run measured on the OpenRouter
spend panel; the session-pinned `or-claude-haiku-4-5` averaged $2.94). Live
bake-off on the Tier 1 stack, 2026-08-17, per the standing ladder (m1
kill-test → m2b, winner twice consecutively green):

- **`openrouter/deepseek/deepseek-v4-flash`** ($0.08/M in, $0.16/M out, 1M
  ctx; gateway route `or-deepseek-v4-flash`): m1 smoke 9/9; **m2b 12/12
  twice consecutively** (20m and 14m; all five stages accepted, amendment
  re-gate and overspend halt included). Whole-bake-off OpenRouter spend —
  four m1 runs plus both m2b runs — was **$0.36**, putting a full m2b run
  at roughly **$0.10–0.15**: ~10x under the v3.2 floor it succeeds.
  **`or-deepseek-v4-flash` is the new cheapest PROVEN tier** and the
  setup/smoke default from PR #67 on.
- **`openrouter/qwen/qwen3-coder-next`** ($0.12/M in, $0.80/M out; route
  `or-qwen3-coder-next` kept for experiments): **FLOORED** — the m1
  kill-test failed twice identically with the hollow-completion signature
  this file already records for `gemini-flash-lite` (task `completed`, no
  branch pushed). Killed at the m1 rung for ~4¢ total.
- Operational note: the first OpenCode spawn after a daemon container
  recreate can fail in ~1s (`agent_error.process_failure`, "Unexpected
  error", no session) and succeed on retry — a cold-start artifact observed
  2026-08-17, worth a warm-up run before judging any model on a fresh
  container.


## Addendum 2026-08-17b — v0.4.26 agent-lifecycle authz (PR #47 bump gate)

The v0.4.26 conformance run went 16/20: every failure traced to upstream
MUL-6126 ("make private runtimes owner-only in the API and CLI too",
multica#6905). Probed live on the upgraded guild-dev stack:

- `POST /api/agents` (hire) — conductor (workspace admin) → **403** "this
  runtime is private; only its owner can create agents on it"; daemon
  (runtime owner) → 201.
- `PUT /api/agents/{id}` runtime move — conductor → **403** "only its owner
  can move agents onto it"; daemon → 200.
- `PUT /api/agents/{id}/env` — conductor → 200 (admin still allowed).
- `POST /api/agents/{id}/archive` — conductor → 200 (admin still allowed).

A second layer sits behind the first: daemon-created agents default to
`visibility/permission_mode: private`, and issue ASSIGNMENT to a private
agent is refused for everyone but its owner (conductor assign → 403
"cannot assign to private agent"). The resolution is the new permission
surface: create with `permission_mode: "public_to"` and
`invocation_targets: [{target_type: "member", target_id: <member>}]` —
probed live: daemon-created public_to[conductor] agent, conductor assign →
200. Consequence: D16 hiring and every rebind ride the daemon credential
from v0.4.26 on (`agentLifecycleToken` in the adapter; D16 amendment
2026-08-17), and every hire/provisioned agent allow-lists its dispatcher.
The 2026-08-02 note "admin suffices on private runtimes" is superseded for
create/move. Also re-observed: a task dispatched to a just-recreated
daemon's FIRST OpenCode spawn can fail (`process_failure`, ~1s) and succeed
on retry — warm up fresh containers before judging.

## Addendum 2026-08-22 — v0.4.32 bump gate (PR #69)

Six upstream releases (v0.4.27–v0.4.32) in one hop; LICENSE byte-identical
to the accepted v0.4.26 text. Conformance against live v0.4.32: **20/20 with
zero code adaptation** — notably MUL-6380 ("align private-agent invoke
surfaces with the owner-only contract", v0.4.30) is compatible with the
public_to + member-allow-list shape Guild adopted for MUL-6126, and
MUL-6463's run-promotion confirmation did not surface on the API dispatch
path. One first-run failure reproduced the KNOWN stale-runtime-row race
(not a v0.4.32 regression): right after a daemon recreate the dead
container's runtime row is still inside its heartbeat grace window, and
`ensureAgent`/`hireAgent` pick the FIRST online row — the conformance
agent bound to the corpse and its task sat `queued` forever. Clean re-run
once the row expired. Fix tracked as an issue: prefer the newest
(`last_seen_at`) online row.
