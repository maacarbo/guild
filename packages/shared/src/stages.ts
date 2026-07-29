/**
 * Governance-context published language: stages, plans, engagements.
 * Vocabulary per CLAUDE.md ubiquitous language; lifecycle per ARCHITECTURE.md.
 */

import type { HandoffContract } from "./contract.js";

export type StageKind = "analysis" | "architecture" | "implementation" | "test" | "delivery";

export type EngagementState =
  | "planned"
  | "gated"
  | "dispatched"
  | "working"
  | "blocked"
  | "reported"
  | "validated"
  | "bounced"
  | "accepted";

export interface EngagementPlan {
  engagementId: string;
  role: string;
  title: string;
  instructions: string;
  /** authored upstream, before implementation (D6) */
  contract: HandoffContract;
  budgetUsd: number;
}

export interface StagePlan {
  projectId: string;
  stageId: string;
  kind: StageKind;
  objective: string;
  engagements: EngagementPlan[];
  budgetUsd: number;
}
