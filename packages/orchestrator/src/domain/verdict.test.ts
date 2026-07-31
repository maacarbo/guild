import { describe, expect, it } from "vitest";
import type { CheckResult } from "@guild/shared";
import { assembleVerdict } from "./verdict.js";

const cmd = (outcome: CheckResult["outcome"], detail = "d"): CheckResult => ({
  check: { kind: "command", run: "true", expectExitCode: 0, timeoutSeconds: 10 },
  outcome,
  detail,
});

const base = {
  engagementId: "eng-1",
  contractId: "c-1",
  contractVersion: 2,
  commitSha: "691ba57e9efde694e4471f83552cc84e7fd785e4",
  checkedAt: "2026-07-31T14:00:00Z",
};

describe("assembleVerdict (D6 outcome rules)", () => {
  it("passes when every check passed", () => {
    const v = assembleVerdict(base, [cmd("passed"), cmd("passed")]);
    expect(v.outcome).toBe("passed");
    expect(v.commitSha).toBe(base.commitSha);
    expect(v.contractVersion).toBe(2);
  });

  it("fails (bounce the work) when any check failed and none errored", () => {
    expect(assembleVerdict(base, [cmd("passed"), cmd("failed")]).outcome).toBe("failed");
  });

  it("is a validator error when any check errored — infra faults never bounce the work", () => {
    expect(assembleVerdict(base, [cmd("failed"), cmd("error")]).outcome).toBe("validator_error");
  });

  it("passes vacuously with zero checks (a no-check contract validates trivially)", () => {
    expect(assembleVerdict(base, []).outcome).toBe("passed");
  });

  it("carries every check result for the decisions trail", () => {
    const v = assembleVerdict(base, [cmd("passed", "a"), cmd("failed", "b")]);
    expect(v.results.map((r) => r.detail)).toEqual(["a", "b"]);
  });
});
