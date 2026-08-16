/**
 * Mechanical enforcement of the hexagonal dependency rule (CLAUDE.md D7):
 * adapters → application → domain, never outward-in; domain performs no I/O;
 * @guild/shared is the dependency-free published language.
 * Run: pnpm deps:check
 */
module.exports = {
  forbidden: [
    {
      name: "no-unresolvable",
      comment:
        "an import the resolver cannot follow is graded by NO other rule — treating it as valid is a gate bypass (audit 2026-08-15)",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "testkit-is-test-only",
      comment:
        "testkit/ is live-test support: production code (domain/application/ports/adapters/bin) never imports it. " +
        "Deliberately redundant with no-unresolvable for `@guild/*/testkit`: depcruise 18.1 defaults exportsFields to [] " +
        "so subpath-export imports stay unresolvable (the specifier-text alternative below matches them); if exports-map " +
        "resolution is ever enabled, the /src/testkit/ branch takes over on the resolved path — the gate holds either way.",
      severity: "error",
      from: { pathNot: "\\.test\\.ts$|/src/testkit/|/features/" },
      to: { path: "/src/testkit/|@guild/[^/]+/testkit" },
    },
    {
      name: "domain-no-outer-layers",
      comment: "domain/ imports nothing from application/, ports/, or adapters/",
      severity: "error",
      from: { path: "packages/[^/]+/src/domain" },
      to: { path: "packages/[^/]+/src/(application|ports|adapters)" },
    },
    {
      name: "domain-pure",
      comment:
        "domain/ does no I/O and pulls no SDKs: only SAME-package domain files and @guild/shared (tests exempt — they import the runner; $1 pins the package so cross-context domain imports fail too)",
      severity: "error",
      from: { path: "^packages/([^/]+)/src/domain", pathNot: "\\.test\\.ts$" },
      to: { pathNot: "^packages/(shared/src|$1/src/domain)" },
    },
    {
      name: "application-inward-only",
      comment: "application/ depends on SAME-package domain + ports (+ @guild/shared) only (tests exempt)",
      severity: "error",
      from: { path: "^packages/([^/]+)/src/application", pathNot: "\\.test\\.ts$" },
      to: { pathNot: "^packages/(shared/src|$1/src/(domain|application|ports))" },
    },
    {
      name: "ports-owned-by-the-inside",
      comment: "ports/ never reaches outward to adapters/ or application/",
      severity: "error",
      from: { path: "packages/[^/]+/src/ports" },
      to: { path: "packages/[^/]+/src/(adapters|application)" },
    },
    {
      name: "shared-stays-dependency-free",
      comment: "@guild/shared imports nothing outside itself (published language)",
      severity: "error",
      from: { path: "packages/shared/src" },
      to: { pathNot: "^packages/shared/src" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
  },
};
