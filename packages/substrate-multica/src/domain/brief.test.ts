import { describe, expect, it } from "vitest";
import type { EngagementBrief } from "@guild/shared";
import { renderBrief } from "./brief.js";

const brief: EngagementBrief = {
  roleContext: "You are the implementation engineer.",
  instructions: "Create GREETING.md containing exactly: hello guild",
  contract: {
    contractId: "contract-greeting",
    version: 1,
    authoredBy: "analyst",
    gherkin: "Feature: Greeting\n  Scenario: file exists\n    Then GREETING.md contains hello guild",
    checks: [
      { kind: "artifact", path: "GREETING.md", mustContain: "hello guild" },
      { kind: "command", run: "test -f GREETING.md", expectExitCode: 0, timeoutSeconds: 30 },
    ],
  },
  priorDecisions: ["Greeting language is English (analysis stage)."],
  artifactRefs: ["docs/PRODUCT.md"],
  constraints: ["Do not modify any other file."],
};

describe("renderBrief (issue body an agent starts from, context-fresh)", () => {
  it("carries every brief section — upstream decisions must survive the fresh-context reset", () => {
    const body = renderBrief(brief);
    expect(body).toContain("implementation engineer");
    expect(body).toContain("Create GREETING.md");
    expect(body).toContain("Greeting language is English");
    expect(body).toContain("docs/PRODUCT.md");
    expect(body).toContain("Do not modify any other file.");
  });

  it("shows the acceptance contract (D6: criteria are authored upstream, visible before work)", () => {
    const body = renderBrief(brief);
    expect(body).toContain("contract-greeting");
    expect(body).toContain("Feature: Greeting");
    expect(body).toContain("GREETING.md");
  });

  it("tells the agent the verdict comes from automated validation of the pushed commit, not self-report", () => {
    const body = renderBrief(brief).toLowerCase();
    expect(body).toContain("validated");
    expect(body).toContain("push");
  });
});
