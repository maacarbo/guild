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
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Decision records D1–D9 (with honest superseded/retained statuses), engagement lifecycle, deployment topology |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones M0–M4 with acceptance criteria |
| [docs/VALIDATION-2026-07-29.md](docs/VALIDATION-2026-07-29.md) | External validation of the original decisions, with sources |
| [docs/research/external-reviews-2026-07-30.md](docs/research/external-reviews-2026-07-30.md) | Four independent non-Anthropic model reviews — all blockers dispositioned: [disposition table](docs/research/external-reviews-disposition.md) |
| [docs/research/](docs/research/) | Full evidence trail: multica comparison, source-level investigation, review responses |

## Deployment

Two supported deployment targets, lowest barrier first — full details in [deploy/README.md](deploy/README.md):

1. **Docker Compose** — any machine with Docker, no Kubernetes; the tier every functional milestone (M1–M3, through the feature-complete product) ships on and exercises continuously. **[Run the Tier 1 quickstart →](deploy/compose/README.md)**
2. **Any Kubernetes** *(optional, last — pursued only if needed, at M4)* — vanilla manifests: any StorageClass or external databases (dual-mode), plain `kubectl` secrets, hardening (NetworkPolicies, gVisor) recommended where your infra supports it, never assumed.

(The author's hardened cluster is documented as a personal, non-normative runbook — required for nobody.)

## Repository layout

```
packages/
  shared/                 published language: stages, HandoffContract, ExecutionSubstrate + ModelGateway ports
  orchestrator/           the Guild conductor: contract validator (docker-run sandbox driver), LiteLLM gateway adapter, M1 smoke feature
  substrate-multica/      ExecutionSubstrate adapter over Multica's REST/WS API (anti-corruption layer)
  substrate-conformance/  reusable ExecutionSubstrate port contract suite — mandatory-green on every Multica pin bump
deploy/                   deployment options: compose (shipped, M1) / any-K8s (optional generic manifests at M4)
docker/daemon/            custom Multica daemon image (delivered at M1) — pinned CLIs + git + headless login + LiteLLM routing
docs/                     product, architecture, roadmap, validation evidence, research
```

## Status

*(as of 2026-08-03)* **M1 complete, M2a complete — the governed core loop runs end to end on the live stack.** M1 (accepted 2026-07-31) proved the substrate: the Tier 1 compose stack with the doctor diagnostic, the pinned daemon image (OpenCode default + Claude Code), the `ExecutionSubstrate` port with its Multica adapter and conformance suite (the standing pin-bump gate), and the first SHA-pinned contract validation through the sandboxed `docker run` driver — every probe recorded in the [capability matrix](docs/research/capability-matrix-m1a.md). M2a (accepted 2026-08-03, `pnpm smoke:m2a` green twice) ran one real engagement through the whole governed lifecycle: board-gate approval by a real operator lane move, saga dispatch with a budget-capped virtual key, a genuine bounce on a hollow completion with the same agent's real fix, SHA-pinned re-validation, operator acceptance fast-forwarding the target branch, and a conductor killed mid-engagement whose replacement recovered purely from reads. Pre-`v0.1.0`: M2b (planner, starter team, budget watchdog) ships `v0.1.0`; team evolution at M3 (`v0.2.0`); Kubernetes stays an optional last milestone (M4). Every design claim above traces to cited evidence in `docs/`.

## Development

Requires Node ≥ 22 and pnpm 10 (note: corepack is no longer bundled with Node ≥ 25 — install pnpm directly):

```sh
npm install -g pnpm@10
pnpm install
pnpm -r typecheck
```

Development discipline is defined in [CLAUDE.md](CLAUDE.md) — hexagonal ports & adapters, DDD ubiquitous language, TDD, BDD. Contributions welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) and the [issue tracker](https://github.com/maacarbo/guild/issues).

## License

Guild's code: [Apache-2.0](LICENSE). Multica is a separate project under its own source-available license — review it before deploying.
