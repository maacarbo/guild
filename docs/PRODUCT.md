# Guild — Product Specification

*Repositioned 2026-07-29 after ecosystem research — see [research/multica-comparison-2026-07-29.md](research/multica-comparison-2026-07-29.md) and [research/multica-investigation-2026-07-29.md](research/multica-investigation-2026-07-29.md). The original whole-platform spec is in git history.*

**Guild is an open-source autonomous-SDLC governance layer, built on [Multica](https://github.com/multica-ai/multica).** You give it a product idea; it produces a staged delivery plan, gates each stage on your approval, dispatches scoped work to a team of coding agents running on a self-hosted [Multica](https://github.com/multica-ai/multica) instance, validates every handoff against a machine-checkable contract before the pipeline advances, and enforces a spend budget with a kill-switch. Guild does not rebuild the agent platform — Multica's board, runtimes, and skills are the execution substrate; Guild is the discipline on top.

## Principles

- **Clean and legal, always** (operator directive, 2026-07-30: "Don't transgress any policy or rules. We want to keep this app clean and legal!"). Policy compliance is a **gate, never a trade-off**: provider terms of service (e.g. no consumer-subscription credentials driving automation — the D9 rejection), Multica's source-available license (pin the version, review the LICENSE diff on every bump), and any third-party terms. Where compliance is ambiguous or unverified, the answer is no.
- **Cheap models for testing.** Probes, the doctor, test suites, and the smoke default to the gateway's cheap tier — never frontier models. Capability floors discovered per task are recorded as evidence (see the capability matrix), not worked around silently.
- **The apps Guild builds always follow DDD** — an M3+ commitment, not yet enforced (operator directive, 2026-08-02; full design in [issue #8](https://github.com/maacarbo/guild/issues/8); today's only mechanical enforcement is the architecture stage's `## Modules` floor check — #23 E5): bounded-context decomposition at every project size, modular-monolith deployment by default with machine-enforced boundaries, promotion to separate services only via an evidence-carrying, operator-gated plan amendment.

## Problem

Agent task platforms (Multica being the strongest) orchestrate *human-authored* tasks on a flat, gate-free board. Verified gaps in that model, from Multica's own tracker and docs:

- **No staged pipeline** — flat issues, any status to any status; the community asks for AI-led workflow structure (multica#815).
- **No approval gate** — tasks run the moment they're dispatched; the top-voted open feature request asks for orchestration gates (multica#1943).
- **Self-reported "done" is trusted** — a documented production failure: an agent claimed completion on incomplete work and nothing downstream checked it (multica#1579).
- **No budget enforcement** — cost is recorded, never limited (verified in source; see research).

Guild exists to close exactly those gaps — and only those gaps.

## Users

Built personal-use-first: one operator-owner who submits ideas, approves plans, answers blockers, and accepts stages. Published as non-commercial open source so others can run the same layer on their own Multica instances. Commercial hosting is a **non-goal** (Multica's license requires a commercial agreement for third-party hosting; Guild stays clear by design).

## Core Flows

### 1. Idea → staged plan
The operator writes the idea as a ticket on the board — tickets are the single interaction surface; there is no idea CLI verb (ARCHITECTURE.md D11, operator decision 2026-08-02). Guild detects the operator-authored ticket and its planner decomposes the idea into SDLC stages per the idea's `template:` directive (default `standard`: analysis → architecture → implementation → test → delivery; `quick-fix` and `enterprise` shapes ship in the catalog — D12 amendments), each with roles, scoped work items, and budget allocation.

### 2. Plan approval gate
Before any stage spends tokens, its plan is posted as a board ticket in the Waiting-for-feedback lane; the operator's lane move to Ready-to-work **is** the approval (D11). **Approval is explicit — and today it is the only path**: the designed bounded auto-approve timer (a per-project opt-in for runs you're actively supervising, never the default) is **not yet implemented** — the `auto_approved` decision type and its read paths shipped ahead of any producer (#23 E2). Either way, a flawed, expensive plan can't approve itself while you sleep. Specification defects are the largest measured failure source in multi-agent systems; the gate catches them at their cheapest point.

### 3. Contracted dispatch
For each approved stage, Guild creates **one Multica issue per engagement** — which, by Multica's verified session mechanics, gives every engagement a fresh LLM context (no accumulated-context degradation). Each issue carries a **machine-checkable handoff contract**: acceptance criteria authored upstream, expressed as executable Gherkin plus concrete checks (tests pass, artifacts exist).

### 4. Validation before advance
When an agent reports done, **Guild validates the contract itself** — it never trusts the agent's self-report (multica#1579 is the cautionary tale). Pass → the stage advances; fail → the work item bounces back with the failing criteria. Human stage acceptance remains the final gate.

### 5. Questions and blockers
Agents raise blockers as Multica comments; Guild moves the blocked ticket to the Waiting-for-feedback lane until the operator answers on the ticket — Multica's verified server-side routing delivers the reply to the asking agent with session continuity — then returns it to work. Guild surfaces open blockers per stage; it does not rebuild the conversation UI.

### 6. Budget watchdog
Agent CLIs inside the daemon image route through a LiteLLM gateway; spend is attributed per engagement via a virtual key minted at dispatch — a mechanism M1 proves end-to-end. Enforcement is layered: each engagement key carries a **hard `max_budget`** the gateway enforces automatically from M1a (the model simply stops serving at cap), and the M2b watchdog adds soft-cap warnings plus the **project-level ceiling** whose breach cancels running work via the Multica API and locks dispatch. Multica records cost; Guild *enforces* it.

### 7. Team evolution (M3)
Guild hires by demand: creating/configuring Multica agents for roles the plan requires, composing role context files and role-memory artifacts per engagement (API-backed hiring ratified by ARCHITECTURE.md D16, 2026-08-11).

## MVP Cut

**In (M1–M2):**
- Self-hosted Multica substrate on an isolated Docker-Compose stack — simple to complex; Kubernetes only as the optional last milestone (M4), if needed — including the custom daemon container Guild contributes
- Guild core loop: idea → staged plan → approval gate → contracted dispatch → validation → advance
- Fixed starter team of four roles; one Multica issue per engagement
- LiteLLM-routed daemon image; spend visible per engagement
- Board-driven: Multica's board is the control surface — tickets are truth, communication, and trigger (D11); the CLI covers bootstrap (`guild init`, `guild doctor`) and the emergency kill-switch

**Out (post-`v0.1.0`):** dynamic team evolution (M3 — completes the product on the same compose stack); the optional generic Kubernetes lift and hardening (M4, only if needed). The budget kill-switch is *in* the MVP (M2b watchdog — reorganisation 2026-07-30 fixed this stale label); the author-cluster GitOps material moved to a personal runbook outside the product.

**Out (indefinitely):** own kanban UI, own runtime adapters, own skills catalog (Multica ships all three); commercial hosting of any kind.

## Success Criteria

1. A demo idea goes from submission to a repo with passing tests where **every** stage was plan-gated and **every** handoff was contract-validated — zero un-contracted advances.
2. An induced overspend halts the pipeline cleanly with a visible explanation (M2).
3. A role not present at project start is hired mid-run because the plan demanded it (M3).
