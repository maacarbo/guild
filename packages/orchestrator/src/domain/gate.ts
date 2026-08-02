/**
 * Gate application (pure): a gate decision authorizes exactly (stageId,
 * planVersion) — anything addressed to another stage or a superseded version
 * is stale and authorizes nothing (D6: amending re-gates). Stale rejections
 * are equally inert: an old "no" must never cancel a newer plan.
 */

import type { EngagementPlan, GateDecision, StagePlan } from "@guild/shared";

export type GateOutcome =
  | { kind: "authorized"; engagements: EngagementPlan[] }
  | { kind: "rejected" }
  | { kind: "regate_required" }
  | { kind: "stale_gate"; detail: string };

export function applyGateDecision(plan: StagePlan, decision: GateDecision): GateOutcome {
  if (decision.kind === "amended") return { kind: "regate_required" };

  if (decision.stageId !== plan.stageId || decision.planVersion !== plan.planVersion) {
    return {
      kind: "stale_gate",
      detail: `decision addresses (${decision.stageId}, v${decision.planVersion}); plan is (${plan.stageId}, v${plan.planVersion})`,
    };
  }

  switch (decision.kind) {
    case "approved":
    case "auto_approved":
      return { kind: "authorized", engagements: plan.engagements };
    case "rejected":
      return { kind: "rejected" };
  }
}
