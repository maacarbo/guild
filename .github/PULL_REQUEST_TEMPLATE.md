## What & why

<!-- Imperative summary; reference the milestone/issue. -->

## Checklist (CONTRIBUTING.md)

- [ ] `pnpm -r typecheck` passes
- [ ] `pnpm -r test` passes
- [ ] `pnpm deps:check` passes (hexagonal dependency rule)
- [ ] Red-first TDD: new behavior demonstrated failing before implementation
- [ ] **Docs are normative**: any behavior change updates `ARCHITECTURE.md` / `PRODUCT.md` / `ROADMAP.md` in this same PR; a decision change gets a D-record with an alternatives table
- [ ] No secrets in code, tests, fixtures, or docs (names only, never values)
- [ ] Frozen docs (`docs/research/*`, `docs/VALIDATION-*.md`) untouched — addenda only
