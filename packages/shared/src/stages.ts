/**
 * Governance-context published language: stages, plans, engagements, briefs.
 * Vocabulary per CLAUDE.md ubiquitous language; lifecycle per ARCHITECTURE.md.
 * All identifiers are opaque strings to consumers — the Governance domain that
 * mints them owns their grammar (orchestrator domain/stage.ts) and is the only
 * sanctioned parser. All timestamps ISO-8601 UTC; all money is integer cents
 * (never floating-point currency).
 */

import type { HandoffContract } from "./contract.js";

export type StageKind = "analysis" | "architecture" | "implementation" | "test" | "delivery";

/**
 * The six-lane board plus the off-board terminal (D11). Lanes are ubiquitous
 * language: the board is the control surface — lane membership is the trigger,
 * and the conductor is the sole lane authority. Adapters map lanes onto native
 * status vocabularies (evidence: matrix P20 — Multica's fixed enum maps 1:1).
 */
export type Lane =
  | "backlog"
  | "ready_to_work"
  | "in_progress"
  | "waiting_for_feedback"
  | "ready_for_testing"
  | "done"
  /** terminal, off-board — cancelled work leaves the six visible lanes */
  | "cancelled";

export type EngagementState =
  | "planned"
  | "gated"
  | "dispatched"
  | "working"
  | "blocked"
  | "reported"
  | "validated"
  | "bounced"
  | "accepted"
  /** terminal: cancelled (budget hard cap, operator, stage rejection) — key revoked, item closed */
  | "cancelled"
  /** terminal-pending-operator: bounce limit reached; operator cancels or rescopes */
  | "escalated";

/**
 * Everything an agent needs to start context-fresh (Multica gives a new issue a
 * fresh LLM session): upstream decisions must ride in the brief or they are lost.
 * Identity note: EngagementPlan.engagementId is the single owner; the brief is
 * always transported alongside it (WorkItemSpec) and carries no separate id.
 */
export interface EngagementBrief {
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

/**
 * An advisory rider's brief (#54): identical transport, but there IS no
 * contract — the rider's report is never judged (#29), so a placeholder
 * contract would misstate what the operator approves. `contract?: never`
 * keeps the field readable (as undefined) across the union.
 */
export interface AdvisoryBrief extends Omit<EngagementBrief, "contract"> {
  contract?: never;
}

interface EngagementPlanBase {
  /** single owner of the engagement identity */
  engagementId: string;
  /**
   * invariant: one open engagement per agent — a plan repeating a role is
   * flagged at its gate before anything can dispatch (orchestrator
   * domain/stage.ts `duplicateOpenRole`)
   */
  role: string;
  title: string;
  /** enforced cap: minted into the engagement's gateway virtual key as max_budget at dispatch */
  budgetCents: number;
}

/** contracted work: acceptance criteria exist before dispatch and are judged (D6) */
export interface WorkEngagementPlan extends EngagementPlanBase {
  advisory?: never;
  brief: EngagementBrief;
}

/**
 * observe-and-flag rider (#29, D13's focus-monitor): dispatched, budgeted,
 * and swept like any engagement, but it never gates stage completion, its
 * reports are never contract-judged, and stage completion cancels it
 * (`advisory_stage_end`) through the spend-capturing termination path.
 */
export interface AdvisoryEngagementPlan extends EngagementPlanBase {
  advisory: true;
  brief: AdvisoryBrief;
}

/**
 * The `advisory` flag discriminates: contracted work carries a full
 * EngagementBrief; a rider's brief carries no contract at all (#54) — the
 * type owns the D13 rule instead of a placeholder convention.
 */
export type EngagementPlan = WorkEngagementPlan | AdvisoryEngagementPlan;

export interface StagePlan {
  projectId: string;
  stageId: string;
  /**
   * the stage's identity word within its plan (#28: slug, not kind, names a
   * stage). Optional for plans persisted before 2026-08-16; consumers fall
   * back to the domain's stageSlugOf(stageId).
   */
  slug?: string;
  /**
   * bumped on every amendment; a gate approves exactly (stageId, planVersion) —
   * amending re-gates. Mirrors the contract-immutability rule of D6.
   */
  planVersion: number;
  kind: StageKind;
  objective: string;
  engagements: EngagementPlan[];
  /**
   * advisory allocation for planning; enforcement happens at engagement caps
   * (virtual-key max_budget) and the project cap (ProjectBudget) — stage-level
   * enforcement is deliberately not built until a real need appears
   */
  budgetCents: number;
}
