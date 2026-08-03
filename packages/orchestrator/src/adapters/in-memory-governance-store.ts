/**
 * Reference GovernanceStore: process-local maps. The behavioral contract for
 * the Postgres adapter, and the store the conductor unit tests run against.
 * Not durable — reconciliation-after-restart is exactly what it cannot
 * provide, which is why the acceptance test runs on Postgres.
 */

import type { EngagementState, GateDecision, StagePlan, WorkItemRef } from "@guild/shared";
import type { DecisionEntry } from "../domain/decisions.js";
import type {
  EngagementRecord,
  GateTicketKey,
  GovernanceStore,
  PlanRunRecord,
} from "../ports/governance-store.js";

export class InMemoryGovernanceStore implements GovernanceStore {
  private readonly engagements = new Map<string, EngagementRecord>();
  private readonly decisions: DecisionEntry[] = [];
  private readonly intents = new Map<string, string>();
  private readonly gateTickets = new Map<string, WorkItemRef>();
  private readonly gateDecisions = new Map<string, GateDecision>();
  private readonly planRuns = new Map<string, PlanRunRecord>();
  private readonly stagePlans = new Map<string, StagePlan>();
  private dispatchLock: { reason: string; at: string } | null = null;

  async saveEngagement(record: EngagementRecord): Promise<void> {
    this.engagements.set(record.engagementId, { ...record });
  }
  async saveEngagementIf(record: EngagementRecord, expectedState: EngagementState): Promise<boolean> {
    const current = this.engagements.get(record.engagementId);
    if (!current || current.state !== expectedState) return false;
    this.engagements.set(record.engagementId, { ...record });
    return true;
  }
  async getEngagement(engagementId: string): Promise<EngagementRecord | null> {
    const rec = this.engagements.get(engagementId);
    return rec ? { ...rec } : null;
  }
  async listEngagements(): Promise<EngagementRecord[]> {
    return [...this.engagements.values()].map((r) => ({ ...r }));
  }
  async appendDecision(entry: DecisionEntry): Promise<void> {
    this.decisions.push(entry);
  }
  async listDecisions(): Promise<DecisionEntry[]> {
    return [...this.decisions];
  }
  async recordDispatchIntent(engagementId: string, at: string): Promise<void> {
    if (!this.intents.has(engagementId)) this.intents.set(engagementId, at);
  }
  async listDispatchIntents(): Promise<string[]> {
    return [...this.intents.keys()];
  }
  async saveGateTicket(stageId: string, planVersion: number, item: WorkItemRef): Promise<void> {
    this.gateTickets.set(`${stageId}:v${planVersion}`, item);
  }
  async getGateTicket(stageId: string, planVersion: number): Promise<WorkItemRef | null> {
    return this.gateTickets.get(`${stageId}:v${planVersion}`) ?? null;
  }
  async findGateTicketByItem(item: WorkItemRef): Promise<GateTicketKey | null> {
    for (const [key, ref] of this.gateTickets) {
      if (ref.externalId !== item.externalId) continue;
      const at = key.lastIndexOf(":v");
      return { stageId: key.slice(0, at), planVersion: Number.parseInt(key.slice(at + 2), 10) };
    }
    return null;
  }
  async recordGateDecision(decision: GateDecision): Promise<boolean> {
    const key = `${decision.stageId}:v${decision.planVersion}`;
    if (this.gateDecisions.has(key)) return false;
    this.gateDecisions.set(key, decision);
    return true;
  }
  async savePlanRun(run: PlanRunRecord): Promise<void> {
    this.planRuns.set(run.planId, { ...run, stageIds: [...run.stageIds] });
  }
  async getPlanRun(planId: string): Promise<PlanRunRecord | null> {
    const run = this.planRuns.get(planId);
    return run ? { ...run, stageIds: [...run.stageIds] } : null;
  }
  async listPlanRuns(): Promise<PlanRunRecord[]> {
    return [...this.planRuns.values()].map((r) => ({ ...r, stageIds: [...r.stageIds] }));
  }
  async saveStagePlan(plan: StagePlan): Promise<void> {
    this.stagePlans.set(`${plan.stageId}:v${plan.planVersion}`, structuredClone(plan));
  }
  async getStagePlan(stageId: string, planVersion: number): Promise<StagePlan | null> {
    const plan = this.stagePlans.get(`${stageId}:v${planVersion}`);
    return plan ? structuredClone(plan) : null;
  }
  async getLatestStagePlan(stageId: string): Promise<StagePlan | null> {
    let latest: StagePlan | null = null;
    for (const plan of this.stagePlans.values()) {
      if (plan.stageId === stageId && (!latest || plan.planVersion > latest.planVersion)) latest = plan;
    }
    return latest ? structuredClone(latest) : null;
  }
  async setDispatchLock(reason: string, at: string): Promise<void> {
    this.dispatchLock = { reason, at };
  }
  async getDispatchLock(): Promise<{ reason: string; at: string } | null> {
    return this.dispatchLock ? { ...this.dispatchLock } : null;
  }
  async clearDispatchLock(): Promise<void> {
    this.dispatchLock = null;
  }
}
