/**
 * The append-only decision trail (D4 status note, D11): every governance
 * transition the conductor makes lands here as a typed entry — provenance is
 * a queryable record, never reconstructed from substrate state.
 */

import type {
  BounceOutcome,
  BudgetEvent,
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
  | { kind: "termination"; terminated: EngagementTerminated }
  /** M3 team evolution: staffing acts are governance provenance like any gate (never a type without its producer — #23 E2) */
  | { kind: "hire"; role: string; agentId: string; planId: string; at: string }
  | { kind: "retire"; role: string; agentId: string; planId: string; at: string }
  /** watchdog provenance (D12): every cap event and lock release is queryable */
  | { kind: "budget"; event: BudgetEvent };
