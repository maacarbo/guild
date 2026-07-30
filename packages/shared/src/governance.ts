/**
 * Typed governance events — everything the append-only `decisions` table records
 * and the conductor's state machine consumes. Added 2026-07-30 after external
 * review: without these, M1/M2 implementers invent ad-hoc state.
 */

import type { ContractVerdict } from "./contract.js";
import type { SubstrateErrorCategory, WorkItemRef } from "./substrate.js";

export type GateDecision =
  | { kind: "approved"; stageId: string; by: "operator"; at: string }
  /** only possible when auto-approve was explicitly enabled for the project — never a default */
  | { kind: "auto_approved"; stageId: string; timerSeconds: number; at: string }
  | { kind: "amended"; stageId: string; note: string; at: string }
  | { kind: "rejected"; stageId: string; note: string; at: string };

export type DispatchOutcome =
  | { kind: "dispatched"; engagementId: string; workItem: WorkItemRef; at: string }
  | { kind: "failed"; engagementId: string; error: SubstrateErrorCategory; detail: string; at: string };

/**
 * Bounce rules (D6): contracts are immutable once dispatched; a bounce returns to
 * the same agent + issue; bounce spend draws from the same engagement budget;
 * after MAX_BOUNCES the next failure escalates to the operator instead of re-dispatching.
 */
export const MAX_BOUNCES = 2;

export interface BounceOutcome {
  engagementId: string;
  /** 1-based count of this bounce; bounceCount > MAX_BOUNCES escalates instead */
  bounceCount: number;
  verdict: ContractVerdict;
  at: string;
}

/** caps trigger at spentCents >= capCents; the gateway is the source of truth when telemetry lags */
export type BudgetEvent =
  | { kind: "soft_cap"; scope: "engagement" | "project"; spentCents: number; capCents: number; at: string }
  | {
      kind: "hard_cap";
      scope: "engagement" | "project";
      spentCents: number;
      capCents: number;
      /** engagement ids whose in-flight work was cancelled; dispatch is locked until operator action */
      cancelled: string[];
      at: string;
    };

export type CancellationReason = "budget_hard_cap" | "operator" | "bounce_limit" | "stage_rejected";
