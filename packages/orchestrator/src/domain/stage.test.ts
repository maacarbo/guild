import { describe, expect, it } from "vitest";
import type { EngagementState, StagePlan } from "@guild/shared";
import {
  acceptanceLine,
  advisoryRiders,
  duplicateOpenRole,
  engagementIdFor,
  gateMarker,
  isAdvisory,
  stageComplete,
  stageIdFor,
  stageSlugOf,
} from "./stage.js";

function planWith(
  engagements: Array<{ engagementId: string; role: string; advisory?: true }>,
): StagePlan {
  return {
    projectId: "proj-1",
    stageId: "stg:idea-1:analysis",
    planVersion: 1,
    kind: "analysis",
    objective: "o",
    budgetCents: 100,
    engagements: engagements.map((e) => ({
      ...e,
      title: e.engagementId,
      budgetCents: 50,
      brief: {
        roleContext: "",
        instructions: "",
        contract: { contractId: "c", version: 1, authoredBy: "operator", gherkin: "", checks: [] },
        priorDecisions: [],
        artifactRefs: [],
        constraints: [],
      },
    })),
  };
}

describe("the domain owns the stage identity grammar (audit hexagonal-3/clean-3)", () => {
  it("mints stage, engagement, and gate identities from one source", () => {
    expect(stageIdFor("idea-1", "analysis")).toBe("stg:idea-1:analysis");
    expect(stageIdFor("idea-1", "business-analysis")).toBe("stg:idea-1:business-analysis");
    expect(engagementIdFor("stg:idea-1:analysis", 2)).toBe("eng:stg:idea-1:analysis:v2");
    expect(gateMarker("stg:idea-1:analysis", 3)).toBe("gate:stg:idea-1:analysis:v3");
  });

  it("stageSlugOf inverts stageIdFor — byte-identical for every persisted pre-#28 id", () => {
    expect(stageSlugOf(stageIdFor("idea-1", "architecture-security"))).toBe("architecture-security");
    expect(stageSlugOf("stg:idea-1:analysis")).toBe("analysis");
  });

  it("acceptanceLine is the ONE canonical phrasing role memory and prior decisions dedup on", () => {
    expect(acceptanceLine("stg:idea-1:analysis", "sha-a")).toBe("analysis stg:idea-1:analysis accepted at sha-a");
  });
});

describe("stage completion is a domain rule (audit ddd-2; #29 semantics, D12/D13)", () => {
  const states = (m: Record<string, EngagementState>) => (id: string) => m[id];

  it("completes when every non-advisory engagement is accepted — riders never gate", () => {
    const plan = planWith([
      { engagementId: "e1", role: "implementer" },
      { engagementId: "m1", role: "focus-monitor", advisory: true },
    ]);
    expect(stageComplete(plan, states({ e1: "accepted", m1: "working" }))).toBe(true);
    expect(stageComplete(plan, states({ e1: "working", m1: "accepted" }))).toBe(false);
  });

  it("an empty or all-advisory stage never completes — the deliberate fail-safe wedge (pinned)", () => {
    expect(stageComplete(planWith([]), states({}))).toBe(false);
    expect(
      stageComplete(planWith([{ engagementId: "m1", role: "focus-monitor", advisory: true }]), states({ m1: "accepted" })),
    ).toBe(false);
  });

  it("selects the riders a completed stage must cancel, and answers advisory membership", () => {
    const plan = planWith([
      { engagementId: "e1", role: "implementer" },
      { engagementId: "m1", role: "focus-monitor", advisory: true },
    ]);
    expect(advisoryRiders(plan).map((e) => e.engagementId)).toEqual(["m1"]);
    expect(isAdvisory(plan, "m1")).toBe(true);
    expect(isAdvisory(plan, "e1")).toBe(false);
    expect(isAdvisory(plan, "missing")).toBe(false);
  });
});

describe("one open engagement per agent (audit ddd-1; D6)", () => {
  it("flags a plan whose engagements repeat a role — the role-keyed key binding would cross-meter them", () => {
    expect(
      duplicateOpenRole(
        planWith([
          { engagementId: "e1", role: "implementer" },
          { engagementId: "e2", role: "implementer" },
        ]),
      ),
    ).toBe("implementer");
  });

  it("passes distinct roles — advisory riders run under their own role by design", () => {
    expect(
      duplicateOpenRole(
        planWith([
          { engagementId: "e1", role: "implementer" },
          { engagementId: "m1", role: "focus-monitor", advisory: true },
        ]),
      ),
    ).toBeNull();
  });
});
