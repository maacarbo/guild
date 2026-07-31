import { describe, expect, it } from "vitest";
import type { ContractVerdict } from "@guild/shared";
import { renderBounceComment } from "./bounce.js";

const verdict: ContractVerdict = {
  engagementId: "eng-1",
  contractId: "contract-greeting",
  contractVersion: 1,
  commitSha: "abc1234def5678900000000000000000deadbeef",
  outcome: "failed",
  checkedAt: "2026-07-31T12:00:00Z",
  results: [
    {
      check: { kind: "command", run: "pnpm test", expectExitCode: 0, timeoutSeconds: 120 },
      outcome: "failed",
      detail: "exit code 1: 2 tests failed in greeting.test.ts",
    },
    {
      check: { kind: "artifact", path: "GREETING.md", mustContain: "hello" },
      outcome: "passed",
      detail: "present",
    },
  ],
};

describe("renderBounceComment (self-contained per M1a P7)", () => {
  it("names the contract and the validated commit", () => {
    const body = renderBounceComment(verdict);
    expect(body).toContain("contract-greeting");
    expect(body).toContain("abc1234def5678900000000000000000deadbeef");
  });

  it("lists only the failing checks, with their evidence detail", () => {
    const body = renderBounceComment(verdict);
    expect(body).toContain("pnpm test");
    expect(body).toContain("2 tests failed in greeting.test.ts");
    expect(body).not.toContain("GREETING.md");
  });

  it("instructs the agent to fix and push on the same branch — self-contained, no session assumption", () => {
    const body = renderBounceComment(verdict);
    expect(body.toLowerCase()).toContain("push");
    expect(body.toLowerCase()).toContain("branch");
  });
});
