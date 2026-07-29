# Guild — Roadmap

Milestones are sequential; each has a demoable acceptance bar. GitLab milestones + one tracking issue per milestone mirror this document.

## M0 — Foundations ✅ (this session)

Monorepo scaffold, product spec, architecture with recorded decisions, CI skeleton, event-contract types.

## M1 — Core loop MVP

Idea in, working code out — no UI yet (CLI/API trigger).

- Orchestrator: project creation, stage planning, task decomposition, board projection to Postgres
- `agent-runtime` with the Claude Code adapter (headless, SDK version pinned); agents as child processes
- NATS JetStream via docker-compose; event contracts wired end to end with D4's normative retention/idempotency semantics (LimitsPolicy streams, durable pull consumers, envelope-id dedup, `version` field)
- LiteLLM gateway (pinned version + image digest) with per-role model policy; **acceptance test: Claude feature parity through the proxy** (prompt caching, extended thinking); spend logging with OTel/Langfuse export
- Stage-plan approval gate (API-level) and machine-checkable handoff contracts (D6), expressed as executable Gherkin (D7)
- All code per `CLAUDE.md` discipline: hexagonal/DDD layering with mechanical dependency-rule enforcement, TDD, BDD feature specs, port contract-test suite for `AgentRuntimeAdapter`; single-writer workspace discipline
- Soft per-engagement budget cap with kill-switch (D3 `interrupt`)
- Fixed team: business analyst → architect → implementer → tester — context-fresh per engagement

**Acceptance:** a demo idea submitted via API produces a repo with passing tests, with human input limited to plan approvals, answering questions (over the API), and final acceptance.

## M2 — Human-in-the-loop UI

- Next.js app: idea intake, kanban board (To Do / In Progress / Review / Done), question feed
- SSE live updates (behind a client-side transport abstraction); answers routed to the asking agent by correlation id
- Stage-plan approval in the UI with bounded auto-approve timer; stage acceptance (approve / request changes); optional critic-agent plan review
- AG-UI payload-mapping evaluation before UI hardening (D5)

**Acceptance:** the entire M1 flow driven from the browser; a question asked by an agent is answered in the feed and demonstrably unblocks that agent.

## M3 — Runtime & model expansion

- Second runtime adapter: OpenCode (server mode; first task: re-confirm the permissions endpoint against the official OpenAPI spec); adapter interface hardened against Claude-shape bias
- Per-adapter capability mapping table (runtime-neutral manifest → native mechanisms) as an acceptance deliverable
- Suspend/resume via serializable handles proven on both runtimes
- Model backends exercised through LiteLLM: native provider, OpenRouter, local Ollama
- Per-role model policy configurable per project (capability tier vs. cost)

**Acceptance:** the M1 demo passes on two different runtimes and three model backends without orchestrator changes.

## M4 — Dynamic team evolution

- Role-template registry and capability catalog (skills, MCP servers, automations) as data, not code
- Role-memory artifacts: compact per-role memory composed into each fresh engagement context
- Hiring policy: queue depth / stage demand triggers hiring; idle agents retired
- Capability selection at provision time filtered by role fit

**Acceptance:** during a run, the system hires a specialist role that was not in the starting team because demand appeared, and retires it when demand ends — visible on the board.

## M5 — Kubernetes production

- **Entry gate:** evaluate Kubernetes Agent Sandbox (SandboxTemplate/WarmPool/Claim — pause/resume, persistent storage, hardened runtimes) against Job-per-engagement before building the substrate
- Helm chart: orchestrator, UI, NATS, LiteLLM, Postgres; agents as Jobs with PVC workspaces and `runtimeClassName` gVisor/Kata (benchmark I/O overhead on representative builds first)
- Decide Redis/Valkey for LiteLLM budget enforcement vs. documented single-replica SPOF
- NetworkPolicies (agents → NATS + LiteLLM only; DNS scoped to the cluster resolver); secrets isolated to the hardened gateway pod
- Observability: full GenAI-semconv OpenTelemetry tracing per task (version-pinned — the semconv is experimental), structured logs, basic dashboards

**Acceptance:** `helm install` on a fresh cluster, then the full M2 flow runs entirely in-cluster.

## M6 — Enterprise hardening

- Multi-project concurrency; full hierarchical per-project budget enforcement at the gateway (Redis + fail-closed setting; the per-engagement kill-switch ships in M1)
- RBAC/SSO for the UI; audit log of all agent actions and human decisions
- Delivery hardening: generated apps ship with their own CI and Helm charts

**Acceptance:** two projects run concurrently under different budget ceilings; one hits its ceiling and halts cleanly with a board notification; every action is attributable in the audit log.
