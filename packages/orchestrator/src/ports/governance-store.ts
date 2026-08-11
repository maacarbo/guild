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
  /**
   * the final gateway spend reading, persisted BEFORE key revocation (#12):
   * a crash between revocation and the termination-entry append would
   * otherwise lose the spend forever (revoked keys are unreadable), letting a
   * near-cap project under-trigger its hard cap. Accounting annotation only —
   * lives on the record, never on the domain Engagement, and is never read by
   * transitions (D7 purity).
   */
  terminalSpendCents?: number;
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
  /**
   * project-wide dispatch lockout (budget hard cap OR kill switch): the saga
   * checks before minting. capCents is the project hard cap in force when the
   * lock was set — the sweep releases a lock only when the configured cap is
   * raised above it (raise-the-cap-and-restart, D12). Absent capCents means the
   * lock is never sweep-released (a kill fired with no project budget) (A1).
   */
  setDispatchLock(reason: string, at: string, capCents?: number): Promise<void>;
  getDispatchLock(): Promise<{ reason: string; at: string; capCents?: number } | null>;
  clearDispatchLock(): Promise<void>;
  /**
   * The project hard cap the RUNNING conductor is actually enforcing, persisted
   * at conductor startup. A separate process (`guild kill`) reads this to stamp
   * the kill lock's capCents with the conductor's authoritative frozen cap
   * rather than its own — possibly divergent — env read (A1): the two processes
   * must agree on the cap or the lock can self-release. Null until a conductor
   * with a project budget has started.
   */
  setEnforcedHardCap(cents: number): Promise<void>;
  getEnforcedHardCap(): Promise<number | null>;
}
