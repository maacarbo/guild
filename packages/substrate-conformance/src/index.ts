/**
 * ExecutionSubstrate port conformance suite (CLAUDE.md TDD rules; load-bearing
 * for D8): one reusable test suite that every substrate adapter must pass —
 * `substrate-multica` today, any fallback adapter tomorrow. Also the substrate
 * conformance gate: mandatory-green on every Multica pin bump and daemon image
 * rebuild (ROADMAP M1b).
 *
 * The suite runs against real infrastructure (the Tier 1 compose stack), never
 * mocks — adapters are integration-tested per CLAUDE.md. Environments provide
 * the wiring via {@link ConformanceEnv}.
 */

import type { ExecutionSubstrate, WorkItemSpec } from "@guild/shared";

export interface ConformanceEnv {
  substrate: ExecutionSubstrate;
  /** scope handed to listWorkItems/watch — e.g. the Multica workspace id */
  projectScope: string;
  /** a role assignable to new work items in this environment */
  role: string;
  /** minimal valid spec with a fresh, unique engagementId per call */
  makeSpec(overrides?: Partial<Omit<WorkItemSpec, "engagementId">>): WorkItemSpec;
  /** same substrate wired with invalid credentials — for auth classification */
  unauthenticatedSubstrate(): ExecutionSubstrate;
}

export function describeExecutionSubstrateConformance(
  _setup: () => Promise<ConformanceEnv>,
): void {
  throw new Error(
    "conformance suite not yet implemented — M1b task: TDD red phase pending",
  );
}
