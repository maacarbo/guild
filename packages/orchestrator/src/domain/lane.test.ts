import { describe, expect, it } from "vitest";
import type { EngagementState } from "@guild/shared";
import { laneFor, type Lane } from "./lane.js";

/** D11 lane projection — six lanes plus the off-board terminal, total over EngagementState */
describe("laneFor", () => {
  const expected: Record<EngagementState, Lane> = {
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

  it("projects every engagement state onto exactly the D11 lane", () => {
    for (const [state, lane] of Object.entries(expected)) {
      expect(laneFor(state as EngagementState)).toBe(lane);
    }
  });

  it("keeps planned-but-unapproved work visible in Backlog rather than hidden", () => {
    expect(laneFor("planned")).toBe("backlog");
    expect(laneFor("gated")).toBe("backlog");
  });

  it("returns bounced work to the go lane so the agent's rework is authorized by lane membership", () => {
    expect(laneFor("bounced")).toBe(laneFor("dispatched"));
  });
});
