// Feature-to-runner map: the M1 smoke (default) and the M2a acceptance (m2a
// profile) run under cucumber; contract-validation.feature is documentation
// for scenarios executed by the vitest suites (its header says which files)
// and has no cucumber steps.
export default {
  paths: ["features/m1-smoke.feature"],
  import: ["features/steps/m1-smoke.steps.ts"],
};
export const m2a = {
  paths: ["features/m2a-governed-engagement.feature"],
  import: ["features/steps/m2a-governed-engagement.steps.ts"],
};
export const m2b = {
  paths: ["features/m2b-planner-team-watchdog.feature"],
  import: ["features/steps/m2b-planner-team-watchdog.steps.ts"],
};
