/**
 * The Stage: identity grammar and advance invariants, domain-owned
 * (audit 2026-08-15 — previously minted and re-parsed across four
 * application-layer sites with nothing but convention keeping them in step).
 *
 * Identity: the planner mints `stg:<ideaId>:<slug>` /
 * `eng:<stageId>:v<planVersion>` / `gate:<stageId>:v<planVersion>`. The
 * published language keeps these opaque for consumers; the domain that mints
 * an id may also parse it — `stageSlugOf` is `stageIdFor`'s inverse and the
 * only sanctioned parse.
 */

import type { EngagementPlan, EngagementState, StagePlan } from "@guild/shared";

export function stageIdFor(ideaId: string, slug: string): string {
  return `stg:${ideaId}:${slug}`;
}

export function engagementIdFor(stageId: string, planVersion: number): string {
  return `eng:${stageId}:v${planVersion}`;
}

/** the gate ticket's substrate marker — the dedup key for idempotent posts */
export function gateMarker(stageId: string, planVersion: number): string {
  return `gate:${stageId}:v${planVersion}`;
}

/** inverse of stageIdFor (#28: the slug is the id's last segment) */
export function stageSlugOf(stageId: string): string {
  return stageId.slice(stageId.lastIndexOf(":") + 1);
}

/**
 * The ONE canonical acceptance phrasing: role memory and openStage's
 * run-local prior-decision lines dedup on byte identity (M3, #28 — the
 * leading token is the slug, byte-identical to the kind for pre-#28 rows).
 */
export function acceptanceLine(stageId: string, sha: string): string {
  return `${stageSlugOf(stageId)} ${stageId} accepted at ${sha}`;
}

/**
 * Stage completion (D12, #29): every non-advisory engagement accepted, and at
 * least one required. required === 0 (empty stage, or all-advisory) never
 * completes — the deliberate fail-safe wedge: a stage that can produce no
 * acceptable work must stall visibly, never advance silently. A planner that
 * emits advisory riders must emit ≥ 1 non-advisory engagement too.
 */
export function stageComplete(
  plan: StagePlan,
  stateOf: (engagementId: string) => EngagementState | undefined,
): boolean {
  let required = 0;
  for (const ep of plan.engagements) {
    if (ep.advisory) continue; // observe-and-flag riders never gate completion (#29)
    required++;
    if (stateOf(ep.engagementId) !== "accepted") return false;
  }
  return required > 0;
}

/** the observe-and-flag riders a completed stage must cancel (#29: `advisory_stage_end`) */
export function advisoryRiders(plan: StagePlan): EngagementPlan[] {
  return plan.engagements.filter((e) => e.advisory === true);
}

/** whether this engagement is an advisory rider of its plan (#29: never contract-judged) */
export function isAdvisory(plan: StagePlan, engagementId: string): boolean {
  return plan.engagements.find((e) => e.engagementId === engagementId)?.advisory === true;
}

/**
 * One open engagement per agent (D6): the substrate's engagement-key binding
 * is role-keyed with wholesale env replacement, so two concurrently-open
 * same-role engagements would cross-meter their spend. A plan that repeats a
 * role is flagged before its gate posts — approval is the only dispatch
 * trigger, so a warned operator amends instead of arming the collision.
 */
export function duplicateOpenRole(plan: StagePlan): string | null {
  const seen = new Set<string>();
  for (const ep of plan.engagements) {
    if (seen.has(ep.role)) return ep.role;
    seen.add(ep.role);
  }
  return null;
}
