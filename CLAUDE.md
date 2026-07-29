# Guild — Development Guidelines

Guild is a collaboration-first multi-agent SDLC platform. Read these before writing code; they are normative. Architecture rationale lives in `docs/ARCHITECTURE.md` (decision records D1–D7); this file operationalizes it.

| Doc | Contents |
|---|---|
| `docs/PRODUCT.md` | Vision, personas, flows, MVP cut |
| `docs/ARCHITECTURE.md` | Decision records D1–D7, lifecycle, event contracts, K8s topology |
| `docs/ROADMAP.md` | Milestones M0–M6 with acceptance criteria |
| `docs/VALIDATION-*.md` | Historical evidence records — never edit |

## Architecture: hexagonal (ports & adapters) — D7

Every package with behavior (`orchestrator`, `agent-runtime`, `adapters`) uses this internal layout:

```
src/
  domain/        pure model: entities, value objects, aggregates, domain services
  application/   use cases; depends on domain + ports only
  ports/         interfaces owned by the inside (driving and driven)
  adapters/      infrastructure bindings: NATS, Postgres, LiteLLM, runtime SDKs, HTTP
```

**The dependency rule is absolute: `adapters → application → domain`, never outward-in.**

- `domain/` imports nothing from outer layers and performs no I/O — no NATS, no Postgres, no HTTP, no SDKs, no environment access.
- The event bus is an adapter. Domain and application code publish through a driven port (e.g. `EventPublisher`); only an adapter knows NATS exists.
- Board projections (D4) are adapters; the domain model is persistence-ignorant.
- `AgentRuntimeAdapter` (D3) is a driven port; the Claude Code and OpenCode implementations are adapters. The existing naming already conforms — keep it that way.
- `@guild/shared` is the **published language** between contexts: event contracts and port types only. It stays dependency-free and contains no behavior.
- Enforce the dependency rule mechanically (dependency-cruiser or eslint boundaries — pick and pin at M1 bootstrap, record the choice here).

## DDD

**Bounded contexts map to packages:**

| Context | Package | Aggregates / concepts |
|---|---|---|
| Orchestration | `orchestrator` | Project, Stage, StagePlan, Task, HandoffContract, board projection |
| Team | `agent-runtime` + `adapters` | Agent, Role, RoleTemplate, Engagement, Workspace, CapabilityManifest |
| — (published language) | `shared` | event contracts, adapter port |

The UI is a driving adapter of the Orchestration context, not a context.

- **Ubiquitous language is the vocabulary already in `docs/PRODUCT.md` and `docs/ARCHITECTURE.md`**: hire, retire, engagement, stage, handoff contract, question, board, claim. Code identifiers use these words. If a better word is found, rename docs and code in the same MR — never let them drift.
- Aggregates guard invariants in the domain layer: task state transitions (`todo → in_progress → review → done`), single-writer-per-workspace (D6.4), one open engagement per agent.
- Domain events are the contracts in `@guild/shared` — past-tense facts (`task.moved`, `agent.hired`), envelope semantics per D4 (at-least-once, dedup on `id`, `version` field).

## TDD

- **Red → green → refactor. No production code without a failing test first.** This includes "trivial" code.
- Unit tests colocated as `*.test.ts`, targeting `domain/` and `application/` — pure and fast, no infrastructure, no mocking of infrastructure (there is none to mock at those layers).
- Don't mock what you don't own: wrap third-party things in a port and fake the port.
- **Port contract tests**: every driven port gets one reusable test suite that all its adapters must pass. This is load-bearing for D3 — the Claude Code and OpenCode adapters pass the *same* `AgentRuntimeAdapter` suite, which is what "hardened against Claude-shape bias" (M3) means in practice.
- Adapter integration tests run against real infrastructure via docker-compose (NATS, Postgres) — not against mocks of it.
- Test names state behavior ("retires an idle agent after the demand window closes"), never implementation ("calls delete").
- Coverage is an outcome, not a target. CI runs typecheck + unit tests on every MR.

## BDD

- Every stage/feature starts as Gherkin scenarios in `features/` (per package), written in the ubiquitous language, declarative, no UI mechanics.
- **D6 handoff contracts are executable BDD specs.** The upstream role authors `.feature` acceptance criteria *before* implementation; the tester runs them and never validates the implementer's self-report. This applies to Guild's own development now, and to what Guild's agents produce from M1 on — same discipline, one mechanism.
- Scenario acceptance = the milestone acceptance bars in `docs/ROADMAP.md`; if a scenario doesn't trace to a requirement, delete it.
- Tooling: Vitest for unit/integration, `@cucumber/cucumber` for feature specs — confirm exact packages and versions at M1 bootstrap and record them here.

## Working conventions

- Node ≥ 22, pnpm via corepack (`corepack enable && pnpm install`); `pnpm -r typecheck` must pass before every commit; `pnpm -r test` once test suites exist.
- Branch per task, MR into `main`, CI green before merge. Single-writer discipline (D6.4) binds humans and agents alike: one writer per branch.
- Commits: imperative summary line, body explains why, reference the milestone/issue.
- Docs are normative. A behavior change updates `ARCHITECTURE.md` / `PRODUCT.md` / `ROADMAP.md` in the same MR. A decision change gets a D-record with an alternatives table — no silent reversals.
- Version pins are deliberate (LiteLLM digest, Claude Agent SDK — see D2/D3): never bump inside an unrelated MR.

## Guardrails

- Provider credentials exist only in the LiteLLM gateway's config (D2). Never in agent workspaces, code, tests, or fixtures. `.env` files are local-only and gitignored.
- Anything outward-facing an agent does (push, deploy) goes through the D3 permission surface — do not add side channels.
- GitLab group shared runners are disabled; CI stays pending until a group runner is registered (tracked in issue #5).
