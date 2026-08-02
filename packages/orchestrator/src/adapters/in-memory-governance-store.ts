/**
 * Reference GovernanceStore: process-local maps. The behavioral contract for
 * the Postgres adapter, and the store the conductor unit tests run against.
 * Not durable — reconciliation-after-restart is exactly what it cannot
 * provide, which is why the acceptance test runs on Postgres.
 */

import type { WorkItemRef } from "@guild/shared";
import type { DecisionEntry } from "../domain/decisions.js";
import type { EngagementRecord, GovernanceStore } from "../ports/governance-store.js";

export class InMemoryGovernanceStore implements GovernanceStore {
  private readonly engagements = new Map<string, EngagementRecord>();
  private readonly decisions: DecisionEntry[] = [];
  private readonly intents = new Map<string, string>();
  private readonly gateTickets = new Map<string, WorkItemRef>();

  async saveEngagement(record: EngagementRecord): Promise<void> {
    this.engagements.set(record.engagementId, { ...record });
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
}
