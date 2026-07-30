/**
 * Governance-context published language: stages, plans, engagements, briefs.
 * Vocabulary per CLAUDE.md ubiquitous language; lifecycle per ARCHITECTURE.md.
 * All identifiers are opaque strings; all timestamps ISO-8601 UTC; all money is
 * integer cents (never floating-point currency).
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

/**
 * Everything an agent needs to start context-fresh (Multica gives a new issue a
 * fresh LLM session): upstream decisions must ride in the brief or they are lost.
 */
export interface EngagementBrief {
  engagementId: string;
  /** role template + role-memory artifact, composed by the conductor */
  roleContext: string;
  instructions: string;
  contract: HandoffContract;
  /** upstream decisions that must survive the fresh-context reset */
  priorDecisions: string[];
  /** branches, files, docs the agent needs (repo-relative or URL) */
  artifactRefs: string[];
  constraints: string[];
}

export interface EngagementPlan {
  engagementId: string;
  /** invariant: one open engagement per agent — enforced by the planner before dispatch */
  role: string;
  title: string;
  brief: EngagementBrief;
  budgetCents: number;
}

export interface StagePlan {
  projectId: string;
  stageId: string;
  kind: StageKind;
  objective: string;
  engagements: EngagementPlan[];
  budgetCents: number;
}
