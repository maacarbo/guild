# Guild Agent Manual

The canonical, machine-readable how-to for operating Guild. Guild's users are
partly agents by design: hand this file to any agent (or human) and it can
drive the product end to end — submit ideas, govern gates, read verdicts,
halt spend. Every how-to below **names its covering test or check** in an
HTML marker; CI verifies each named file exists and is an executed artifact
(`packages/orchestrator/src/adapters/agent-manual.test.ts`) — live-stack
covers (`*.feature`, `*.steps.ts`, `doctor.sh`) run under `pnpm smoke`, not
in CI.

Vocabulary (normative, from `docs/PRODUCT.md` / `docs/ARCHITECTURE.md`): an
**idea** becomes a staged **plan**; each **stage** posts a **gate** the
operator approves; approved stages dispatch **engagements** to hired agents;
work **validates** against a machine-checkable **handoff contract**, then the
operator **accepts** (or the conductor **bounces**) it. All control actions
are **board actions** on Multica tickets or comments — there is no other
control surface (D11).

Deployment facts: Multica backend `http://127.0.0.1:8080`, board UI `:3000`,
LiteLLM gateway `:4000` — all loopback. Every API call below needs
`Authorization: Bearer <token>` and `x-workspace-id: <GUILD_WORKSPACE_ID>`
headers. Tokens are named here by their `.env` variable, never by value:
`GUILD_OPERATOR_TOKEN` (the operator — ideas and gate moves MUST use this
identity; the conductor ignores anyone else's approvals) and
`GUILD_MULTICA_TOKEN` (the conductor — read-only use by tooling).

Board lanes map to issue `status` values: ready-to-work = `todo`,
waiting-for-feedback = `blocked`, done = `done`, cancelled = `cancelled`.

---

## To provision a Guild deployment (one-time)

<!-- howto: provision | covered-by: deploy/compose/doctor/doctor.sh, packages/orchestrator/features/steps/m2b-planner-team-watchdog.steps.ts -->

Bring up the compose stack, then run `guild init` (package
`@guild/orchestrator`, bin `guild-init`) with `GUILD_WORKSPACE_ID` and
`MULTICA_DEV_VERIFICATION_CODE` set (both required — the dev-code auth flow
mints every identity); `GUILD_MULTICA_URL`, `GUILD_OPERATOR_EMAIL`, and
`GUILD_AGENT_MODEL` carry sensible defaults. It mints the three member identities (operator,
conductor, daemon — distinct by construction), creates the four starter role
agents (`guild-analyst/architect/implementer/tester`), pre-marks all three
accounts past Multica's stock onboarding (#16), and prints the conductor/.env
values to your terminal (never to a file). Full quickstart:
`deploy/compose/README.md`.

Expected outcome: `guild-init` exits 0 and prints the `.env` lines to paste —
the conductor section (`GUILD_MULTICA_TOKEN`, `GUILD_ROLE_AGENTS`, the
member-id allowlist) **and** the daemon section (`MULTICA_DAEMON_TOKEN`);
paste all of them or doctor's daemon checks go red.

## To check the deployment is healthy

<!-- howto: check-health | covered-by: deploy/compose/doctor/doctor.sh -->

From `deploy/compose`:

```bash
docker compose -p guild-dev -f docker-compose.yml -f docker-compose.dev.yml run --rm doctor
```

Expected outcome: `doctor: all checks green` (7 checks, in order: env,
Multica control plane, LiteLLM gateway liveliness, model route + completion,
daemon credentials + identity split, daemon runtime + role-agent bindings,
git PAT). Any `[FAIL]` line names the fix and the service to restart.

## To submit an idea

<!-- howto: submit-idea | covered-by: packages/orchestrator/features/steps/m2b-planner-team-watchdog.steps.ts, packages/orchestrator/src/domain/planner.test.ts -->

Create a board ticket **as the operator** (the conductor adopts only
operator-authored, marker-less tickets):

```bash
curl -X POST http://127.0.0.1:8080/api/issues \
  -H "Authorization: Bearer $GUILD_OPERATOR_TOKEN" \
  -H "x-workspace-id: $GUILD_WORKSPACE_ID" \
  -H "Content-Type: application/json" \
  -d '{"title": "Idea: <what you want>", "description": "<the idea text>\n\nbudget: 5.00\ntemplate: standard", "allow_duplicate": true}'
```

Directives are **own-line** grammar (prose that merely ends in
`budget: 3` never counts):

- `budget: 5.00` — plan budget in dollars (integer-cent math; per-directive
  clamp at $100). Without it, the configured default applies.
- `template: standard` (analysis → architecture → implementation → test →
  delivery, budget split 15/15/40/20/10), `template: quick-fix`
  (implementation → test, 70/30), or `template: enterprise`
  (business-analysis → technical-analysis → architecture-security →
  implementation → test → delivery, 10/10/15/35/20/10 — #28). Unknown names
  degrade to `standard` with a gate-body warning.

Expected outcome: within a reconcile tick the conductor comments a plan
reference on your ticket and posts the first stage's **gate ticket** in the
waiting-for-feedback lane. Every Guild-authored ticket carries the same
HTML-comment marker key in its description — `<!-- guild:engagement=… -->`;
the gate's marker value is `gate:stg:<ideaId>:<stageSlug>:v<n>`, an
engagement's is `eng:stg:<ideaId>:<stageSlug>:v<n>` (the slug equals the
stage kind for `standard`/`quick-fix`; enterprise slugs like
`business-analysis` are their own identities — #28). Nothing spends before
you approve.

## To approve a stage gate

<!-- howto: approve-gate | covered-by: packages/orchestrator/features/steps/m2b-planner-team-watchdog.steps.ts -->

Read the gate ticket body — it renders the full stage plan: objective,
budget, the complete handoff contract (floor checks ∪ upstream-authored
checks, with warnings for anything degraded or stage-inappropriate), and any
role memory carried in. Approval covers exactly what the body shows. Approve
by moving the gate ticket to the ready-to-work lane:

```bash
curl -X PUT http://127.0.0.1:8080/api/issues/<gate-ticket-id> \
  -H "Authorization: Bearer $GUILD_OPERATOR_TOKEN" \
  -H "x-workspace-id: $GUILD_WORKSPACE_ID" \
  -H "Content-Type: application/json" \
  -d '{"status": "todo"}'
```

Expected outcome: the stage's engagement ticket appears; the agent is hired
at dispatch when its role has no standing agent; a budget-capped virtual key
is minted; work begins. Only the operator identity's move counts.

## To amend a stage before approving it

<!-- howto: amend-gate | covered-by: packages/orchestrator/features/steps/m2b-planner-team-watchdog.steps.ts -->

Comment on the **awaiting** gate ticket with the `amend:` grammar; an
optional `budget:` directive on its own line reprices this stage only:

```bash
curl -X POST http://127.0.0.1:8080/api/issues/<gate-ticket-id>/comments \
  -H "Authorization: Bearer $GUILD_OPERATOR_TOKEN" \
  -H "x-workspace-id: $GUILD_WORKSPACE_ID" \
  -H "Content-Type: application/json" \
  -d '{"content": "amend: sharpen the spec toward CLI ergonomics.\nbudget: 0.60"}'
```

Expected outcome: the plan re-derives from the current idea text plus your
note (the note folds into the stage objective), `planVersion` bumps, the old
gate moves off-board, a v2 gate posts in waiting-for-feedback. Amendments
survive conductor downtime (they recover from comments) and beat a
simultaneous stale approval. Rejection is terminal instead: move the gate
ticket to `cancelled` — a new idea is a new ticket.

## To watch progress and read a verdict

<!-- howto: read-verdict | covered-by: packages/orchestrator/features/steps/m2b-planner-team-watchdog.steps.ts -->

The engagement ticket (marker value `eng:stg:<ideaId>:<stageSlug>:v<n>`, same
`guild:engagement=` key as every Guild ticket) is the progress surface: the
agent's report lands as a comment; the conductor validates the pushed branch
against the contract in the Tier 1 sandbox and comments the verdict.
Validation failure posts "Contract validation failed — rework requested" with
each failing check and its evidence, and bounces the work back (max 2
bounces, then the engagement escalates and names the operator action).
Success moves the engagement to **validated** and the ticket to
waiting-for-feedback for your acceptance.

Expected outcome: every verdict is readable on the ticket; the append-only
decisions trail in the governance store holds the same history.

## To accept a validated stage

<!-- howto: accept-stage | covered-by: packages/orchestrator/features/steps/m2b-planner-team-watchdog.steps.ts -->

Move the **engagement ticket** (not the gate) to done:

```bash
curl -X PUT http://127.0.0.1:8080/api/issues/<engagement-ticket-id> \
  -H "Authorization: Bearer $GUILD_OPERATOR_TOKEN" \
  -H "x-workspace-id: $GUILD_WORKSPACE_ID" \
  -H "Content-Type: application/json" \
  -d '{"status": "done"}'
```

Expected outcome: Guild fast-forward-merges the validated SHA (merges are
Guild-mediated — agents never merge), captures final spend, revokes the
engagement key, records role memory, and posts the next stage's gate. When
the **final** stage is accepted, hired-at-dispatch agents are retired
(archived — never restored) and the idea ticket itself moves to Done; until
then a hired agent stays bound, its key already revoked.

## To halt everything (emergency stop)

<!-- howto: emergency-stop | covered-by: packages/orchestrator/src/application/conductor.test.ts -->

Run `guild kill` (bin `guild-kill`; its compose service wires a deliberately
smaller env than the conductor's — exactly what halting needs, nothing that
could fail first). It locks
dispatch FIRST (nothing new can spend even if a later step fails), then
cancels every spending engagement — the substrate cancel kills the agent
process and the engagement key is revoked.

Expected outcome: an explanation comment on the active gate (or idea) ticket;
a persistent dispatch lock that survives restarts. Recovery is deliberate,
never automatic: raise the configured cap above the recorded one and restart
the conductor (D14). The budget watchdog produces the same halt on its own
when project spend crosses the configured hard cap.

## To run the known-good demo

<!-- howto: run-demo | covered-by: packages/orchestrator/features/m2b-planner-team-watchdog.feature, packages/orchestrator/features/steps/m2b-planner-team-watchdog.steps.ts -->

`guild demo` (bin `guild-demo`) posts the word-count demo idea with a
`budget:` directive (`GUILD_DEMO_BUDGET`, default $3) and prints the board
actions to take. It is the same flow this manual documents, end to end; the
`smoke:m2b` acceptance drives it unattended (five gates approved, five
stages validated and accepted, then an induced overspend halts cleanly —
last green 2026-08-13).

## Budget mechanics (reference)

<!-- howto: budget-reference | covered-by: packages/orchestrator/src/domain/planner.test.ts, packages/orchestrator/src/application/conductor.test.ts -->

- Plan budget = idea `budget:` directive (or configured default); stages
  split it by the template's fixed integer percentages (floored to whole
  cents per stage); remainder cents land on implementation.
- Each engagement mints a **virtual key hard-capped at its stage budget** —
  the gateway itself enforces it; provider keys never leave the gateway.
- A 0¢ stage (starved by a tiny plan budget) warns in the gate body — it can
  never dispatch; raise the directive.
- Soft cap (default 80%) warns once on the engagement ticket; the project
  hard cap cancels all in-flight work and locks dispatch (see emergency
  stop). Every terminal engagement records its final spend before key
  revocation.
