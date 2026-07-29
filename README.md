# Guild

A collaboration-first multi-agent platform: submit a product idea and a team of specialist AI agents carries it through the software development lifecycle — analysis, architecture, implementation, testing, deployment — to an app running on Kubernetes. You stay in the loop through a kanban board and a question feed; the team hires and retires specialists as demand evolves.

## Documentation

| Doc | Contents |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Development guidelines: hexagonal/DDD layering, TDD/BDD discipline, conventions (mirrored as AGENTS.md) |
| [docs/PRODUCT.md](docs/PRODUCT.md) | Vision, personas, core flows, MVP cut |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, decision records (D1–D7), agent lifecycle, event contracts, K8s topology |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones M0–M6 with acceptance criteria (mirrored as GitLab milestones/issues) |

## Repository layout

```
packages/
  shared/         event contracts, types, subject naming — depended on by everything
  orchestrator/   project lifecycle, staffing, board projection, HTTP API
  agent-runtime/  agent lifecycle, workspaces, runtime-adapter bridge
  adapters/       AgentRuntimeAdapter implementations (Claude Code first)
  ui/             Next.js board + question feed (scaffolded in M2)
deploy/           docker-compose (dev), Helm chart (M5)
docs/             product, architecture, roadmap
```

## Status

**M0 — Foundations.** Scaffold and design only; no runnable feature code yet. See the roadmap for what lands next (M1: core loop MVP).

## Development

Requires Node ≥ 22 and pnpm (via corepack).

```sh
corepack enable
pnpm install
pnpm -r typecheck
```
