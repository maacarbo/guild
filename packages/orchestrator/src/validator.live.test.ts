/**
 * First proof of the core mechanism (ROADMAP M1b): a hand-written
 * HandoffContract validated SHA-pinned against a real agent-produced branch
 * in the scratch repo, via the docker-run driver — least-trusted sandbox,
 * no credentials, no network. The SHA is an M1a evidence artifact:
 * agent/probe-claude/b226c810's tip, produced by a live daemon agent.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { HandoffContract } from "@guild/shared";
import { createContractValidator } from "./index.js";

const SCRATCH_REPO = process.env.GUILD_SCRATCH_REPO ?? "git@github.com:maacarbo/guild-scratch-m1a";
/** tip of agent/probe-claude/b226c810 — pinned; the branch name plays no part */
const PROBE_SHA = "691ba57e9efde694e4471f83552cc84e7fd785e4";

const workRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".cache", "validator");
mkdirSync(workRoot, { recursive: true });

const validator = createContractValidator({ workRoot, image: "alpine:3.22" });

const probeContract: HandoffContract = {
  contractId: "contract-m1a-probe-delivery",
  version: 1,
  authoredBy: "conductor",
  gherkin: [
    "Feature: Probe delivery",
    "  The implementing agent delivered the M1a probe file and every bounce append.",
    "  Scenario: probe file is complete",
    "    Given the engagement branch is checked out at the reported commit",
    "    Then PROBE.md contains the original probe line",
    "    And PROBE.md records the P6 closed-issue reply",
  ].join("\n"),
  checks: [
    { kind: "artifact", path: "PROBE.md", mustContain: "M1a P3 probe" },
    { kind: "command", run: "grep -q 'P6 seen' PROBE.md", expectExitCode: 0, timeoutSeconds: 30 },
    { kind: "command", run: "test -f PROBE.md", expectExitCode: 0, timeoutSeconds: 30 },
  ],
};

describe("contract validation against the real agent branch (docker-run driver)", () => {
  it("validates the hand-written contract SHA-pinned: passed", async () => {
    const verdict = await validator.validate({
      engagementId: "eng-m1b-proof",
      contract: probeContract,
      repoUrl: SCRATCH_REPO,
      commitSha: PROBE_SHA,
    });
    expect(verdict.outcome).toBe("passed");
    expect(verdict.commitSha).toBe(PROBE_SHA);
    expect(verdict.results).toHaveLength(3);
    expect(verdict.results.every((r) => r.outcome === "passed")).toBe(true);
  });

  it("bounces work that misses the criteria: failed, with evidence detail", async () => {
    const failing: HandoffContract = {
      ...probeContract,
      contractId: "contract-m1a-probe-unicorns",
      checks: [
        { kind: "artifact", path: "PROBE.md", mustContain: "unicorns" },
        { kind: "command", run: "grep -q unicorns PROBE.md", expectExitCode: 0, timeoutSeconds: 30 },
      ],
    };
    const verdict = await validator.validate({
      engagementId: "eng-m1b-proof-fail",
      contract: failing,
      repoUrl: SCRATCH_REPO,
      commitSha: PROBE_SHA,
    });
    expect(verdict.outcome).toBe("failed");
    expect(verdict.results[0]!.detail).toContain("unicorns");
    expect(verdict.results[1]!.detail).toContain("exit 1");
  });

  it("reports validator_error on an unreachable SHA — infra faults never bounce the work", async () => {
    const verdict = await validator.validate({
      engagementId: "eng-m1b-proof-err",
      contract: probeContract,
      repoUrl: SCRATCH_REPO,
      commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });
    expect(verdict.outcome).toBe("validator_error");
    expect(verdict.results.every((r) => r.outcome === "error")).toBe(true);
  });

  it("denies the sandbox network egress (least-trust proof)", async () => {
    const egress: HandoffContract = {
      ...probeContract,
      contractId: "contract-egress-probe",
      checks: [
        // exit 1 expected: no DNS, no route — wget must fail inside the sandbox
        { kind: "command", run: "wget -T 5 -q -O /dev/null http://example.com", expectExitCode: 1, timeoutSeconds: 30 },
      ],
    };
    const verdict = await validator.validate({
      engagementId: "eng-m1b-proof-egress",
      contract: egress,
      repoUrl: SCRATCH_REPO,
      commitSha: PROBE_SHA,
    });
    expect(verdict.outcome).toBe("passed");
  });
});
