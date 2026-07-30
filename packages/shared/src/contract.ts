/**
 * Machine-checkable handoff contracts (D6): acceptance criteria authored by the
 * upstream role before implementation; validated by Guild in a conductor-controlled
 * environment, never by the implementing agent's self-report.
 *
 * Execution semantics (normative, see ARCHITECTURE.md D6):
 * - checks run in a fresh, isolated clone of the engagement branch — never the
 *   daemon's workspace;
 * - every command check carries a mandatory timeout; stdout/stderr are captured
 *   as evidence and referenced from the verdict;
 * - acceptance failure (bounce the work) is distinct from validator error
 *   (infrastructure fault — retry validation, never bounce the work for it).
 */

export type ContractCheck =
  | {
      kind: "command";
      /** executed from the clone root unless cwd overrides (repo-relative) */
      run: string;
      expectExitCode: number;
      timeoutSeconds: number;
      cwd?: string;
    }
  | {
      kind: "artifact";
      /** repo-relative path; existence is the base assertion */
      path: string;
      /** optional content assertion: substring that must be present */
      mustContain?: string;
    };

export interface HandoffContract {
  contractId: string;
  /** bumped only before dispatch — contracts are immutable once dispatched (D6 bounce rules) */
  version: number;
  /** role that authored the contract */
  authoredBy: string;
  /** executable Gherkin feature spec, written in the ubiquitous language */
  gherkin: string;
  checks: ContractCheck[];
}

export interface CheckResult {
  check: ContractCheck;
  /** "error" = the validator could not execute the check (infrastructure fault) */
  outcome: "passed" | "failed" | "error";
  detail: string;
  /** pointer to captured stdout/stderr or artifact snapshot */
  evidenceRef?: string;
}

export interface ContractVerdict {
  /** anchor into the decisions table — which engagement this verdict judges */
  engagementId: string;
  contractId: string;
  contractVersion: number;
  /**
   * the exact commit validated — resolved ONCE when the agent reports done;
   * validation checks out this SHA detached; merge is fast-forward-only to
   * exactly this SHA; a moved head means a new report, never a re-judgment
   */
  commitSha: string;
  /** "failed" bounces the work; "validator_error" retries validation and never bounces */
  outcome: "passed" | "failed" | "validator_error";
  results: CheckResult[];
  /** ISO-8601 UTC */
  checkedAt: string;
  /** pointer to the full evidence bundle for the decisions table */
  evidenceRef?: string;
}
