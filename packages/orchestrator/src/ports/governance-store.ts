/**
 * Driven port over Guild's own governance state (plain Postgres in
 * production, D4): engagement records, the append-only decision trail, and
 * dispatch-intent rows (the saga's crash-recovery anchor). Reads here plus
 * substrate reads are the whole reconciliation surface.
 */

import type { WorkItemRef } from "@guild/shared";
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
}

export interface GovernanceStore {
  saveEngagement(record: EngagementRecord): Promise<void>;
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
}
