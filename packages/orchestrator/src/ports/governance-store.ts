/**
 * Driven port over Guild's own governance state (plain Postgres in
 * production, D4): engagement records, the append-only decision trail, and
 * dispatch-intent rows (the saga's crash-recovery anchor). Reads here plus
 * substrate reads are the whole reconciliation surface.
 */

import type { EngagementState, GateDecision, StagePlan, WorkItemRef } from "@guild/shared";
import type { Engagement } from "../domain/engagement.js";
import type { DecisionEntry } from "../domain/decisions.js";

export interface EngagementRecord extends Engagement {
  /** set once dispatch has created the work item */
  item?: WorkItemRef;
  /** the exact commit the passing verdict pinned — the only sha acceptance may merge (D6) */
  validatedSha?: string;
  /**
   * the branch that actually resolved at the last report — rework fallback:
   * the daemon mints a fresh branch hint per task (P7), but the bounce
   * instruction sends the fix to the branch the work was delivered on
   */
  lastBranch?: string;
  /** the commit the last verdict judged — reconcile's guard against re-judging a bounced engagement's old artifact */
  lastJudgedSha?: string;
  /**
   * the attempt (task run) the last verdict judged — with lastJudgedSha this
   * detects a hollow rework: a NEW attempt whose branch head has NOT moved is
   * judged (and bounced/escalated) instead of stranded (#11)
   */
  lastJudgedAttempt?: string;
}

/**
 * one adopted idea → its ordered stages (D12); planId is the idea ticket's
 * external id. ideaItem is absent for directly-adopted plans (harness/tests) —
 * such runs have no idea ticket to comment on or complete.
 */
export interface PlanRunRecord {
  planId: string;
  ideaItem?: WorkItemRef;
  /** ordered stage ids of the pipeline */
  stageIds: string[];
  status: "active" | "completed" | "rejected";
}

export interface GateTicketKey {
  stageId: string;
  planVersion: number;
}

export interface GovernanceStore {
  saveEngagement(record: EngagementRecord): Promise<void>;
  /**
   * Compare-and-set save (#11): persists only while the stored record still
   * holds expectedState (false = a concurrent writer won; the caller treats it
   * exactly like a rejected transition). A missing record also returns false.
   */
  saveEngagementIf(record: EngagementRecord, expectedState: EngagementState): Promise<boolean>;
  getEngagement(engagementId: string): Promise<EngagementRecord | null>;
  listEngagements(): Promise<EngagementRecord[]>;
  /** append-only — the M2a acceptance bar: every transition lands here */
  appendDecision(entry: DecisionEntry): Promise<void>;
  listDecisions(): Promise<DecisionEntry[]>;
  /** persisted BEFORE any dispatch effect; idempotent — a crash mid-saga resumes, never re-dispatches blind */
  recordDispatchIntent(engagementId: string, at: string): Promise<void>;
  listDispatchIntents(): Promise<string[]>;
  saveGateTicket(stageId: string, planVersion: number, item: WorkItemRef): Promise<void>;
  getGateTicket(stageId: string, planVersion: number): Promise<WorkItemRef | null>;
  /** reverse lookup: which gate does this board item front? (multi-stage event routing) */
  findGateTicketByItem(item: WorkItemRef): Promise<GateTicketKey | null>;
  /**
   * First-writer-wins gate decision per (stageId, planVersion) (#11): true =
   * this call recorded the decision (the caller then appends it to the trail
   * and executes it); false = the gate was already decided.
   */
  recordGateDecision(decision: GateDecision): Promise<boolean>;
  /**
   * What actually stuck for this gate — losers of the race consult it: a
   * re-driven approve resumes dispatch only when the recorded decision IS an
   * approval; a stale reject against an approved gate does nothing (M2b
   * verify finding: an unconditional loser path stranded approved runs).
   */
  getGateDecision(stageId: string, planVersion: number): Promise<GateDecision | null>;
  savePlanRun(run: PlanRunRecord): Promise<void>;
  getPlanRun(planId: string): Promise<PlanRunRecord | null>;
  listPlanRuns(): Promise<PlanRunRecord[]>;
  /** plans are persisted at post time (D12): recovery re-reads, never re-derives */
  saveStagePlan(plan: StagePlan): Promise<void>;
  getStagePlan(stageId: string, planVersion: number): Promise<StagePlan | null>;
  /** the highest-version plan for a stage — the only version a gate may still act on */
  getLatestStagePlan(stageId: string): Promise<StagePlan | null>;
  /** project-wide dispatch lockout (budget hard cap): the saga checks before minting */
  setDispatchLock(reason: string, at: string): Promise<void>;
  getDispatchLock(): Promise<{ reason: string; at: string } | null>;
  clearDispatchLock(): Promise<void>;
}
