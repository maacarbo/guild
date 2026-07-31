/**
 * Verdict assembly (pure) — D6 outcome rules: any errored check makes the
 * whole verdict a validator_error (infrastructure fault — retry validation,
 * never bounce the work for it); otherwise any failed check bounces; only a
 * fully-passing run validates. A no-check contract validates trivially.
 */

import type { CheckResult, ContractVerdict } from "@guild/shared";

export interface VerdictContext {
  engagementId: string;
  contractId: string;
  contractVersion: number;
  /** the exact commit validated — resolved once at report time, D6 */
  commitSha: string;
  /** ISO-8601 UTC */
  checkedAt: string;
}

export function assembleVerdict(ctx: VerdictContext, results: CheckResult[]): ContractVerdict {
  const outcome = results.some((r) => r.outcome === "error")
    ? "validator_error"
    : results.some((r) => r.outcome === "failed")
      ? "failed"
      : "passed";
  return { ...ctx, outcome, results };
}
