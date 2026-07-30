# Guild

**An open-source autonomous-SDLC governance layer for AI agent teams.** Give Guild a product idea; it produces a staged delivery plan, gates each stage on your approval, dispatches contracted work to coding agents running on your self-hosted [Multica](https://github.com/multica-ai/multica) instance, validates every handoff against machine-checkable contracts — never an agent's self-report — and enforces a spend budget with a kill-switch.

Guild deliberately does **not** rebuild the agent platform. Multica ships the board, 14+ CLI runtimes, and skills; Guild is the discipline on top: **stages, gates, contracts, budgets**. Those are precisely the gaps verified absent in Multica (flat gate-free issues — multica#815/#1943; trusted self-reports — multica#1579; cost recorded but never enforced — see `docs/research/`).

Non-commercial by design: built for personal self-hosting, published open source (Apache-2.0 for Guild's own code). Multica itself is source-available — hosting it for third parties requires their commercial license, which Guild's scope deliberately avoids.

## Documentation

| Doc | Contents |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Development guidelines: hexagonal/DDD layering, TDD/BDD discipline, conventions (mirrored as AGENTS.md) |
| [docs/PRODUCT.md](docs/PRODUCT.md) | What Guild does, flows, MVP cut |
| [docs/OVERVIEW.md](docs/OVERVIEW.md) | The map: every component and every data/event flow, with diagrams |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Decision records D1–D8 (with honest superseded/retained statuses), engagement lifecycle, K8s topology |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones M0–M4 with acceptance criteria |
| [docs/VALIDATION-2026-07-29.md](docs/VALIDATION-2026-07-29.md) | External validation of the original decisions, with sources |
| [docs/research/external-reviews-2026-07-30.md](docs/research/external-reviews-2026-07-30.md) | Four independent non-Anthropic model reviews — all blockers dispositioned: [disposition table](docs/research/external-reviews-disposition.md) |
| [docs/research/](docs/research/) | Full evidence trail: multica comparison, source-level investigation, review responses |

## Deployment

Three supported tiers, lowest barrier first — full details in [deploy/README.md](deploy/README.md):

1. **Docker Compose** — any machine with Docker, no Kubernetes; also the stack our own M1 milestone exercises continuously.
2. **Any Kubernetes** — vanilla manifests: any StorageClass or external databases (dual-mode), plain `kubectl` secrets, hardening (NetworkPolicies, gVisor) recommended where your infra supports it, never assumed.
3. **Hardened reference** — the author's cluster (Flux, Cilium FQDN egress, gVisor on Talos), documented as a worked example of tier 2 with everything turned on. Required for nobody.

## Repository layout

```
packages/
  shared/             published language: stages, HandoffContract, ExecutionSubstrate port
  orchestrator/       the Guild conductor: planner, gates, contract validator, budget watchdog
  substrate-multica/  ExecutionSubstrate adapter over Multica's REST/WS API
deploy/               deployment options (compose / any-K8s / hardened reference), secrets flow, storage rules (planned: compose at M1a-0, manifests at M1a-1)
docker/daemon/        custom Multica daemon image spec (planned: Dockerfile at M1a-0) — pinned CLIs + git + headless login + LiteLLM routing
docs/                 product, architecture, roadmap, validation evidence, research
```

## Status

*(as of 2026-07-30)* **M0 complete — design, validation (internal, external cross-model, and Anthropic-side reviews), and reposition.** M1a-0 (prove the substrate on a compose stack: daemon container end-to-end, API probes, spend attribution) is next. No runnable Guild code yet; every design claim above traces to cited evidence in `docs/`.

## Development

Requires Node ≥ 22 and pnpm 10 (note: corepack is no longer bundled with Node ≥ 25 — install pnpm directly):

```sh
npm install -g pnpm@10
pnpm install
pnpm -r typecheck
```

Development discipline is defined in [CLAUDE.md](CLAUDE.md) — hexagonal ports & adapters, DDD ubiquitous language, TDD, BDD.

## License

Guild's code: [Apache-2.0](LICENSE). Multica is a separate project under its own source-available license — review it before deploying.
