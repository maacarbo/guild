# Guild — Roadmap

Milestones are sequential; each has a demoable acceptance bar. GitLab milestones + one tracking issue per milestone mirror this document.

## M0 — Foundations ✅ (this session)

Monorepo scaffold, product spec, architecture with recorded decisions, CI skeleton, event-contract types.

## M1 — Core loop MVP

Idea in, working code out — no UI yet (CLI/API trigger).

- Orchestrator: project creation, stage planning, task decomposition, board projection to Postgres
- `agent-runtime` with the Claude Code adapter (headless); agents as child processes
- NATS JetStream via docker-compose; event contracts wired end to end
- LiteLLM gateway with per-role model policy
- Fixed team: business analyst → architect → implementer → tester

**Acceptance:** a demo idea submitted via API produces a repo with passing tests, with human input limited to answering questions (over the API) and final acceptance.

## M2 — Human-in-the-loop UI

- Next.js app: idea intake, kanban board (To Do / In Progress / Review / Done), question feed
- SSE live updates; answers routed to the asking agent by correlation id
- Stage acceptance (approve / request changes) from the UI

**Acceptance:** the entire M1 flow driven from the browser; a question asked by an agent is answered in the feed and demonstrably unblocks that agent.

## M3 — Runtime & model expansion

- Second runtime adapter: OpenCode; adapter interface hardened against Claude-shape bias
- Model backends exercised through LiteLLM: native provider, OpenRouter, local Ollama
- Per-role model policy configurable per project (capability tier vs. cost)

**Acceptance:** the M1 demo passes on two different runtimes and three model backends without orchestrator changes.

## M4 — Dynamic team evolution

- Role-template registry and capability catalog (skills, MCP servers, hooks) as data, not code
- Hiring policy: queue depth / stage demand triggers hiring; idle agents retired
- Capability selection at provision time filtered by role fit

**Acceptance:** during a run, the system hires a specialist role that was not in the starting team because demand appeared, and retires it when demand ends — visible on the board.

## M5 — Kubernetes production

- Helm chart: orchestrator, UI, NATS, LiteLLM, Postgres; agents as Jobs with PVC workspaces
- NetworkPolicies (agents → NATS + LiteLLM only); secrets isolated to the gateway
- Observability: OpenTelemetry traces per task, structured logs, basic dashboards

**Acceptance:** `helm install` on a fresh cluster, then the full M2 flow runs entirely in-cluster.

## M6 — Enterprise hardening

- Multi-project concurrency; per-project budgets enforced at the gateway
- RBAC/SSO for the UI; audit log of all agent actions and human decisions
- Delivery hardening: generated apps ship with their own CI and Helm charts

**Acceptance:** two projects run concurrently under different budget ceilings; one hits its ceiling and halts cleanly with a board notification; every action is attributable in the audit log.
