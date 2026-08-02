# Contributing to Guild

Everything normative lives in the repo — [CLAUDE.md](CLAUDE.md) (also `AGENTS.md`, a symlink) is the source of truth for development discipline: hexagonal layering, TDD/BDD, ubiquitous language, guardrails. This file is only the checklist.

## Before you open a PR

```sh
npm install -g pnpm@10
pnpm install
pnpm -r typecheck   # CI gate
pnpm -r test        # CI gate (unit tests only)
pnpm deps:check     # CI gate (hexagonal dependency rules)
```

- **Branch per task, PR into `main`, CI green before merge.** One writer per branch (single-writer discipline, D6 — it binds humans and agents alike).
- **Commits:** imperative summary line; body explains *why*; reference the milestone or issue.
- **TDD is not optional:** no production code without a failing test first (CLAUDE.md → TDD).
- **Docs are normative:** a behavior change updates `docs/ARCHITECTURE.md` / `docs/PRODUCT.md` / `docs/ROADMAP.md` in the same PR; a decision change gets a D-record. `docs/VALIDATION-*.md` and `docs/research/` are frozen history — corrections land as dated addenda, never edits.
- **Version pins are deliberate** — never bump one inside an unrelated PR.

## Live-stack tests and the smoke

`*.live.test.ts` suites and `pnpm smoke` run against a local Tier 1 compose stack ([quickstart](deploy/compose/README.md)) and are gated by `GUILD_LIVE_STACK`. **They are not required for a PR** — CI has no stack — but run them when you touch the substrate adapter, the validator, or the gateway adapter; the conformance suite is mandatory-green on any Multica pin bump.

## Where to start

- [Issue tracker](https://github.com/maacarbo/guild/issues) — milestone epics and the spec backlog.
- [docs/ROADMAP.md](docs/ROADMAP.md) — what's being built and in which order.
- Secrets: values never appear in tracked files, only variable names (see `deploy/compose/.env.example`).
