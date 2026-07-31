// Only the smoke feature runs under cucumber; contract-validation.feature is
// documentation for scenarios executed by the vitest suites (its header says
// which files) and has no cucumber steps.
export default {
  paths: ["features/m1-smoke.feature"],
  import: ["features/steps/*.ts"],
};
