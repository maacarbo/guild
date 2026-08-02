/**
 * The append-only decision trail (D4 status note, D11): every governance
 * transition the conductor makes lands here as a typed entry — provenance is
 * a queryable record, never reconstructed from substrate state.
 */

import type {
  BounceOutcome,
  ContractVerdict,
  DispatchOutcome,
  EngagementState,
  EngagementTerminated,
  GateDecision,
} from "@guild/shared";

export type DecisionEntry =
  | { kind: "gate_posted"; stageId: string; planVersion: number; at: string }
  | { kind: "gate"; decision: GateDecision }
  | { kind: "dispatch"; outcome: DispatchOutcome }
  | { kind: "transition"; engagementId: string; from: EngagementState; to: EngagementState; cause: string; at: string }
  | { kind: "verdict"; engagementId: string; verdict: ContractVerdict }
  | { kind: "bounce"; outcome: BounceOutcome }
  | { kind: "termination"; terminated: EngagementTerminated };
