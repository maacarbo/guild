# Guild — Development Guidelines

Guild is an open-source autonomous-SDLC governance layer driving a self-hosted Multica execution substrate (stages, approval gates, handoff contracts, budget enforcement). Read these before writing code; they are normative. Architecture rationale lives in `docs/ARCHITECTURE.md` (decision records D1–D9); this file operationalizes it.

| Doc | Contents |
|---|---|
| `docs/PRODUCT.md` | Vision, flows, MVP cut |
| `docs/ARCHITECTURE.md` | Decision records D1–D9, engagement lifecycle, deployment topology |
| `docs/ROADMAP.md` | Milestones M0–M4 with acceptance criteria |
| `docs/VALIDATION-*.md`, `docs/research/` | Historical evidence records — never edit |

## Architecture: hexagonal (ports & adapters) — D7

Every package with behavior (`orchestrator`, `substrate-multica`) uses this internal layout:

```
src/
  domain/        pure model: entities, value objects, aggregates, domain services
  application/   use cases; depends on domain + ports only
  ports/         interfaces owned by the inside (driving and driven)
  adapters/      infrastructure bindings: Postgres, LiteLLM, Multica REST/WS, HTTP
```

**The dependency rule is absolute: `adapters → application → domain`, never outward-in.**

- `domain/` imports nothing from outer layers and performs no I/O — no HTTP, no Postgres, no SDKs, no environment access.
- **Multica is an adapter.** Domain and application code speak only the `ExecutionSubstrate` port (`@guild/shared`); `substrate-multica` is an anti-corruption layer — Multica's issue/comment/status vocabulary is translated at the adapter boundary and never leaks into the domain (D8).
- Persistence is an adapter; the domain model is persistence-ignorant.
- `@guild/shared` is the **published language** between contexts: stage/plan/engagement types, `HandoffContract`, the `ExecutionSubstrate` port and its event types. It stays dependency-free and contains no domain logic.
- Enforce the dependency rule mechanically (dependency-cruiser or eslint boundaries — pick and pin at M1 bootstrap, record the choice here).

## DDD

**Bounded contexts map to packages:**

| Context | Package | Aggregates / concepts |
|---|---|---|
| Governance | `orchestrator` | Plan, Stage, Engagement, HandoffContract, BudgetLedger, decision trail |
| — (substrate boundary) | `substrate-multica` | anti-corruption adapter for the `ExecutionSubstrate` port |
| — (published language) | `shared` | stage/contract types, substrate port + events |

The CLI is a driving adapter of the Governance context, not a context.

- **Ubiquitous language is the vocabulary already in `docs/PRODUCT.md` and `docs/ARCHITECTURE.md`**: plan, stage, gate, engagement, handoff contract, validate, bounce, accept, hire, retire, budget, kill-switch. Code identifiers use these words. If a better word is found, rename docs and code in the same MR — never let them drift.
- Aggregates guard invariants in the domain layer: engagement state transitions (`Planned → Gated → Dispatched → Working ⇄ Blocked → Reported → Validated | Bounced → Accepted`, with terminal off-path exits `Cancelled` and `Escalated` — see `EngagementState`), no dispatch without an approved plan (of the approved `planVersion`), no advance without a validated contract, single-writer per engagement (D6), one open engagement per agent.
- Contract validation verdicts and gate decisions are appended to the `decisions` table — governance provenance is append-only (D4 status note).

## TDD

- **Red → green → refactor. No production code without a failing test first.** This includes "trivial" code.
- Unit tests colocated as `*.test.ts`, targeting `domain/` and `application/` — pure and fast, no infrastructure, no mocking of infrastructure (there is none to mock at those layers).
- Don't mock what you don't own: wrap third-party things in a port and fake the port.
- **Port contract tests**: every driven port gets one reusable test suite that all its adapters must pass. This is load-bearing for D8 — `substrate-multica` passes the `ExecutionSubstrate` suite, and any future substrate adapter (the D8 fallback path) must pass the same one.
- Adapter integration tests run against real infrastructure via docker-compose (a local Multica instance, Postgres) — not against mocks of it.
- Test names state behavior ("retires an idle agent after the demand window closes"), never implementation ("calls delete").
- Coverage is an outcome, not a target. CI runs typecheck on every MR today; unit tests join the pipeline the moment the first suite exists (and note the runner caveat under Guardrails).

## BDD

- Every stage/feature starts as Gherkin scenarios in `features/` (per package), written in the ubiquitous language, declarative, no UI mechanics.
- **D6 handoff contracts are executable BDD specs.** The upstream role authors `.feature` acceptance criteria *before* implementation; the tester runs them and never validates the implementer's self-report. This applies to Guild's own development now, and to what Guild's agents produce from M1 on — same discipline, one mechanism.
- Scenario acceptance = the milestone acceptance bars in `docs/ROADMAP.md`; if a scenario doesn't trace to a requirement, delete it.
- Tooling: Vitest for unit/integration, `@cucumber/cucumber` for feature specs — confirm exact packages and versions at M1 bootstrap and record them here.

## Working conventions

- Node ≥ 22, pnpm 10 (`npm install -g pnpm@10` — corepack is no longer bundled with Node ≥ 25); `pnpm -r typecheck` must pass before every commit; `pnpm -r test` once test suites exist.
- The repo lives on GitHub (`maacarbo/guild`) — PRs, issues, and CI all happen there.
- Branch per task, PR into `main`, CI green before merge. Single-writer discipline (D6) binds humans and agents alike: one writer per branch.
- Commits: imperative summary line, body explains why, reference the milestone/issue.
- Docs are normative. A behavior change updates `ARCHITECTURE.md` / `PRODUCT.md` / `ROADMAP.md` in the same MR. A decision change gets a D-record with an alternatives table — no silent reversals.
- Version pins are deliberate (LiteLLM digest, Claude Agent SDK — see D2/D3): never bump inside an unrelated MR.

## Guardrails

- Provider credentials exist only in the LiteLLM gateway's config (D2). The daemon container holds only its Multica token and git credentials. Never put keys in agent workspaces, code, tests, or fixtures. `.env` files are local-only and gitignored.
- Outward-facing effects (merges, deploys) are Guild-mediated (D6): agents report, Guild validates and acts — do not add side channels.
- **License guardrail (D8):** never host Multica for third parties, embed it in anything sold, or rebrand its UI. Pin the Multica version; review its LICENSE diff on every upgrade before bumping.
- CI runs on GitHub Actions (`.github/workflows/ci.yml`).
