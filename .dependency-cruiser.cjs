/**
 * Mechanical enforcement of the hexagonal dependency rule (CLAUDE.md D7):
 * adapters → application → domain, never outward-in; domain performs no I/O;
 * @guild/shared is the dependency-free published language.
 * Run: pnpm deps:check
 */
module.exports = {
  forbidden: [
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
        "domain/ does no I/O and pulls no SDKs: only sibling domain files and @guild/shared (tests exempt — they import the runner)",
      severity: "error",
      from: { path: "packages/[^/]+/src/domain", pathNot: "\\.test\\.ts$" },
      to: { pathNot: "^packages/(shared/src|[^/]+/src/domain)" },
    },
    {
      name: "application-inward-only",
      comment: "application/ depends on domain + ports only (tests exempt)",
      severity: "error",
      from: { path: "packages/[^/]+/src/application", pathNot: "\\.test\\.ts$" },
      to: { pathNot: "^packages/(shared/src|[^/]+/src/(domain|application|ports))" },
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
