/**
 * D11 lane projection (pure): the six-lane board plus the off-board terminal,
 * as a total function over EngagementState. Lanes are Guild ubiquitous
 * language — the mapping to Multica's native status enum is the substrate
 * adapter's business (D8), never the domain's.
 */

import type { EngagementState, Lane } from "@guild/shared";

export type { Lane };

const PROJECTION: Record<EngagementState, Lane> = {
  planned: "backlog",
  gated: "backlog",
  dispatched: "ready_to_work",
  bounced: "ready_to_work",
  working: "in_progress",
  blocked: "waiting_for_feedback",
  validated: "waiting_for_feedback",
  escalated: "waiting_for_feedback",
  reported: "ready_for_testing",
  accepted: "done",
  cancelled: "cancelled",
};

export function laneFor(state: EngagementState): Lane {
  return PROJECTION[state];
}
