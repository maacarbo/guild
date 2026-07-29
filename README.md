# Guild

**An open-source autonomous-SDLC governance layer for AI agent teams.** Give Guild a product idea; it produces a staged delivery plan, gates each stage on your approval, dispatches contracted work to coding agents running on your self-hosted [Multica](https://github.com/multica-ai/multica) instance, validates every handoff against machine-checkable contracts — never an agent's self-report — and enforces a spend budget with a kill-switch.

Guild deliberately does **not** rebuild the agent platform. Multica ships the board, 14+ CLI runtimes, and skills; Guild is the discipline on top: **stages, gates, contracts, budgets**. Those are precisely the gaps verified absent in Multica (flat gate-free issues — multica#815/#1943; trusted self-reports — multica#1579; cost recorded but never enforced — see `docs/research/`).

Non-commercial by design: built for personal self-hosting, published open source (Apache-2.0 for Guild's own code). Multica itself is source-available — hosting it for third parties requires their commercial license, which Guild's scope deliberately avoids.

## Documentation

| Doc | Contents |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Development guidelines: hexagonal/DDD layering, TDD/BDD discipline, conventions (mirrored as AGENTS.md) |
| [docs/PRODUCT.md](docs/PRODUCT.md) | What Guild does, flows, MVP cut |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Decision records D1–D8 (with honest superseded/retained statuses), engagement lifecycle, K8s topology |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones M0–M4 with acceptance criteria |
| [docs/VALIDATION-2026-07-29.md](docs/VALIDATION-2026-07-29.md) | External validation of the original decisions, with sources |
| [docs/research/](docs/research/) | The multica comparison and source-level investigation that drove the reposition |

## Repository layout

```
packages/
  shared/             published language: stages, HandoffContract, ExecutionSubstrate port
  orchestrator/       the Guild conductor: planner, gates, contract validator, budget watchdog
  substrate-multica/  ExecutionSubstrate adapter over Multica's REST/WS API
deploy/               docker-compose (dev); K8s at M3 (Multica Helm + daemon + Guild + LiteLLM)
docker/daemon/        custom Multica daemon image (M1): CLIs + git + headless login + LiteLLM routing
docs/                 product, architecture, roadmap, validation evidence, research
```

## Status

**M0 complete — design, validation, and reposition.** M1 (prove the substrate: daemon container end-to-end, API probe, first adapter) is next. No runnable Guild code yet; every design claim above traces to cited evidence in `docs/`.

## Development

Requires Node ≥ 22 and pnpm (via corepack).

```sh
corepack enable
pnpm install
pnpm -r typecheck
```

Development discipline is defined in [CLAUDE.md](CLAUDE.md) — hexagonal ports & adapters, DDD ubiquitous language, TDD, BDD. The repo lives on GitHub (source of truth) with a private GitLab mirror.

## License

Guild's code: [Apache-2.0](LICENSE). Multica is a separate project under its own source-available license — review it before deploying.
