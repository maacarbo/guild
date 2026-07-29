/**
 * Machine-checkable handoff contracts (D6): acceptance criteria authored by the
 * upstream role before implementation; validated by Guild, never by the
 * implementing agent's self-report.
 */

export type ContractCheck =
  | { kind: "command"; run: string; expectExitCode: number }
  | { kind: "artifact"; path: string };

export interface HandoffContract {
  /** role that authored the contract */
  authoredBy: string;
  /** executable Gherkin feature spec, written in the ubiquitous language */
  gherkin: string;
  checks: ContractCheck[];
}

export interface ContractVerdict {
  passed: boolean;
  failures: string[];
  checkedAt: string;
}
