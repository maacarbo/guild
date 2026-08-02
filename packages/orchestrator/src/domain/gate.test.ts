import { describe, expect, it } from "vitest";
import type { GateDecision, StagePlan } from "@guild/shared";
import { applyGateDecision } from "./gate.js";

const plan: StagePlan = {
  projectId: "proj-1",
  stageId: "stage-1",
  planVersion: 2,
  kind: "implementation",
  objective: "build the thing",
  engagements: [
    {
      engagementId: "eng-1",
      role: "implementer",
      title: "do the work",
      budgetCents: 500,
      brief: {
        roleContext: "",
        instructions: "",
        contract: { contractId: "c-1", version: 1, authoredBy: "architect", gherkin: "", checks: [] },
        priorDecisions: [],
        artifactRefs: [],
        constraints: [],
      },
    },
  ],
  budgetCents: 500,
};

const at = "2026-08-02T00:00:00Z";

describe("applyGateDecision", () => {
  it("authorizes the plan's engagements on an operator approval of exactly (stageId, planVersion)", () => {
    const d: GateDecision = { kind: "approved", stageId: "stage-1", planVersion: 2, by: "operator", at };
    const r = applyGateDecision(plan, d);
    expect(r).toEqual({ kind: "authorized", engagements: plan.engagements });
  });

  it("authorizes on an auto-approval — only ever minted when the per-project opt-in is on", () => {
    const d: GateDecision = { kind: "auto_approved", stageId: "stage-1", planVersion: 2, timerSeconds: 300, at };
    expect(applyGateDecision(plan, d).kind).toBe("authorized");
  });

  it("treats an approval of a superseded plan version as stale — amending re-gates", () => {
    const d: GateDecision = { kind: "approved", stageId: "stage-1", planVersion: 1, by: "operator", at };
    expect(applyGateDecision(plan, d).kind).toBe("stale_gate");
  });

  it("treats an approval addressed to another stage as stale, never as authorization", () => {
    const d: GateDecision = { kind: "approved", stageId: "stage-9", planVersion: 2, by: "operator", at };
    expect(applyGateDecision(plan, d).kind).toBe("stale_gate");
  });

  it("rejects the stage on a matching rejection", () => {
    const d: GateDecision = { kind: "rejected", stageId: "stage-1", planVersion: 2, note: "no", at };
    expect(applyGateDecision(plan, d).kind).toBe("rejected");
  });

  it("ignores a stale rejection — it must not cancel a newer plan", () => {
    const d: GateDecision = { kind: "rejected", stageId: "stage-1", planVersion: 1, note: "old", at };
    expect(applyGateDecision(plan, d).kind).toBe("stale_gate");
  });

  it("demands a re-gate on amendment", () => {
    const d: GateDecision = { kind: "amended", stageId: "stage-1", planVersion: 3, note: "rescope", at };
    expect(applyGateDecision(plan, d).kind).toBe("regate_required");
  });
});
