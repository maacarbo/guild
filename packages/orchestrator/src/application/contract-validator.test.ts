import { describe, expect, it } from "vitest";
import type { HandoffContract } from "@guild/shared";
import type { CommandOutcome, CommandRunner, SourceCloner, WorkspaceReader } from "../ports/validator.js";
import { ContractValidator } from "./contract-validator.js";

const contract: HandoffContract = {
  contractId: "contract-probe",
  version: 1,
  authoredBy: "analyst",
  gherkin: "Feature: probe",
  checks: [
    { kind: "artifact", path: "PROBE.md", mustContain: "M1a P3 probe" },
    { kind: "command", run: "grep -q 'P6 seen' PROBE.md", expectExitCode: 0, timeoutSeconds: 30 },
  ],
};

const input = {
  engagementId: "eng-1",
  contract,
  repoUrl: "git@example.com:scratch.git",
  commitSha: "691ba57e9efde694e4471f83552cc84e7fd785e4",
};

class FakeCloner implements SourceCloner {
  cloned: Array<{ repoUrl: string; sha: string }> = [];
  cleanedUp = 0;
  fail = false;
  async cloneAtSha(repoUrl: string, sha: string) {
    if (this.fail) throw new Error("network unreachable");
    this.cloned.push({ repoUrl, sha });
    return { dir: "/fake/clone", cleanup: async () => void this.cleanedUp++ };
  }
}

class FakeRunner implements CommandRunner {
  results = new Map<string, CommandOutcome>();
  ran: string[] = [];
  async runCommand(_dir: string, run: string): Promise<CommandOutcome> {
    this.ran.push(run);
    return this.results.get(run) ?? { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

class FakeReader implements WorkspaceReader {
  files = new Map<string, string>();
  async readFile(_dir: string, path: string) {
    return this.files.get(path) ?? null;
  }
}

const make = () => {
  const cloner = new FakeCloner();
  const runner = new FakeRunner();
  const reader = new FakeReader();
  const validator = new ContractValidator(cloner, runner, reader, () => "2026-07-31T14:00:00Z");
  return { cloner, runner, reader, validator };
};

describe("ContractValidator", () => {
  it("clones the exact SHA, runs all checks, and passes when everything holds", async () => {
    const { cloner, runner, reader, validator } = make();
    reader.files.set("PROBE.md", "M1a P3 probe\nP5 confirmed\nP6 seen");
    const v = await validator.validate(input);
    expect(cloner.cloned).toEqual([{ repoUrl: input.repoUrl, sha: input.commitSha }]);
    expect(runner.ran).toEqual(["grep -q 'P6 seen' PROBE.md"]);
    expect(v.outcome).toBe("passed");
    expect(v.commitSha).toBe(input.commitSha);
    expect(cloner.cleanedUp).toBe(1);
  });

  it("fails the artifact check when the file is missing, naming the path", async () => {
    const { validator } = make();
    const v = await validator.validate(input);
    const artifact = v.results[0]!;
    expect(artifact.outcome).toBe("failed");
    expect(artifact.detail).toContain("PROBE.md");
    expect(v.outcome).toBe("failed");
  });

  it("fails the artifact check when mustContain is absent", async () => {
    const { reader, validator } = make();
    reader.files.set("PROBE.md", "something else entirely");
    const v = await validator.validate(input);
    expect(v.results[0]!.outcome).toBe("failed");
    expect(v.results[0]!.detail).toContain("M1a P3 probe");
  });

  it("fails a command check on wrong exit code, carrying the output as evidence detail", async () => {
    const { reader, runner, validator } = make();
    reader.files.set("PROBE.md", "M1a P3 probe");
    runner.results.set("grep -q 'P6 seen' PROBE.md", {
      exitCode: 1,
      stdout: "",
      stderr: "no match found",
      timedOut: false,
    });
    const v = await validator.validate(input);
    expect(v.results[1]!.outcome).toBe("failed");
    expect(v.results[1]!.detail).toContain("exit 1");
    expect(v.results[1]!.detail).toContain("no match found");
  });

  it("redacts credential-bearing URLs in command evidence — never persists a PAT (A3)", async () => {
    const { reader, runner, validator } = make();
    reader.files.set("PROBE.md", "M1a P3 probe");
    runner.results.set("grep -q 'P6 seen' PROBE.md", {
      exitCode: 1,
      stdout: "fatal: could not read from https://x-access-token:ghp_SECRET123@github.com/o/r.git",
      stderr: "remote: https://user:supersecret@example.com/repo denied",
      timedOut: false,
    });
    const v = await validator.validate(input);
    const detail = v.results[1]!.detail!;
    expect(detail, "the PAT must never land in the append-only trail").not.toContain("ghp_SECRET123");
    expect(detail).not.toContain("supersecret");
    expect(detail).toContain("***@github.com");
  });

  it("redacts credentials in timeout evidence too (A3)", async () => {
    const { reader, runner, validator } = make();
    reader.files.set("PROBE.md", "M1a P3 probe");
    runner.results.set("grep -q 'P6 seen' PROBE.md", {
      exitCode: null,
      stdout: "cloning https://x-access-token:ghp_TIMEOUT@github.com/o/r.git",
      stderr: "",
      timedOut: true,
    });
    const v = await validator.validate(input);
    expect(v.results[1]!.detail).not.toContain("ghp_TIMEOUT");
    expect(v.results[1]!.detail).toContain("***@github.com");
  });

  it("treats a timeout as an acceptance failure, not a validator error (D6)", async () => {
    const { reader, runner, validator } = make();
    reader.files.set("PROBE.md", "M1a P3 probe");
    runner.results.set("grep -q 'P6 seen' PROBE.md", {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: true,
    });
    const v = await validator.validate(input);
    expect(v.results[1]!.outcome).toBe("failed");
    expect(v.results[1]!.detail).toContain("timeout");
    expect(v.outcome).toBe("failed");
  });

  it("reports validator_error when the clone itself fails — infra faults never bounce the work", async () => {
    const { cloner, validator } = make();
    cloner.fail = true;
    const v = await validator.validate(input);
    expect(v.outcome).toBe("validator_error");
    expect(v.results.every((r) => r.outcome === "error")).toBe(true);
    expect(v.results[0]!.detail).toContain("network unreachable");
  });

  it("reports validator_error on clone failure even for a zero-check contract — never a vacuous pass", async () => {
    const { cloner, validator } = make();
    cloner.fail = true;
    const v = await validator.validate({ ...input, contract: { ...contract, checks: [] } });
    expect(v.outcome).toBe("validator_error");
  });

  it("maps an evidence-overflow outcome (null exit, not timed out) to failed — deterministic, convergent", async () => {
    const { reader, runner, validator } = make();
    reader.files.set("PROBE.md", "M1a P3 probe");
    runner.results.set("grep -q 'P6 seen' PROBE.md", {
      exitCode: null,
      stdout: "",
      stderr: "[check output exceeded the evidence limit]",
      timedOut: false,
    });
    const v = await validator.validate(input);
    expect(v.results[1]!.outcome).toBe("failed");
    expect(v.outcome).toBe("failed");
  });

  it("reports a thrown runner fault as a check error and the verdict as validator_error", async () => {
    const { reader, runner, validator } = make();
    reader.files.set("PROBE.md", "M1a P3 probe");
    runner.runCommand = async () => {
      throw new Error("docker daemon not reachable");
    };
    const v = await validator.validate(input);
    expect(v.results[1]!.outcome).toBe("error");
    expect(v.outcome).toBe("validator_error");
  });

  it("still cleans up the clone when checks throw", async () => {
    const { cloner, reader, runner, validator } = make();
    reader.files.set("PROBE.md", "M1a P3 probe");
    runner.runCommand = async () => {
      throw new Error("boom");
    };
    await validator.validate(input);
    expect(cloner.cleanedUp).toBe(1);
  });
});
