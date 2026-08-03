/**
 * GitSourceControl against the scratch repository (SSH creds on the host,
 * GUILD_LIVE_STACK-gated). The ff push here is a no-op push of the current
 * head — proves the plumbing without moving the branch.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitSourceControl } from "./git-source-control.js";

const live = process.env.GUILD_LIVE_STACK === "1";
const SCRATCH_REPO = process.env.GUILD_SCRATCH_REPO ?? "git@github.com:maacarbo/guild-scratch-m1a";
const exec = promisify(execFile);

describe.runIf(live)("GitSourceControl (live)", () => {
  const source = new GitSourceControl();

  it("resolves an existing branch head to a 40-hex sha", async () => {
    const sha = await source.resolveRemoteSha(SCRATCH_REPO, "main");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  }, 60_000);

  it("resolves a nonexistent branch to null — the hollow-completion signal", async () => {
    expect(await source.resolveRemoteSha(SCRATCH_REPO, "no-such-branch-ever")).toBeNull();
  }, 60_000);

  it("fast-forwards main to its own head (no-op ff) without error", async () => {
    const { stdout } = await exec("git", ["ls-remote", SCRATCH_REPO, "refs/heads/main"]);
    const sha = stdout.trim().split(/\s/)[0]!;
    await source.fastForward(SCRATCH_REPO, "main", sha);
  }, 120_000);

  it("reads a file at exactly a sha; a missing path degrades to null, never a crash (D12)", async () => {
    const { stdout } = await exec("git", ["ls-remote", SCRATCH_REPO, "refs/heads/main"]);
    const sha = stdout.trim().split(/\s/)[0]!;
    // README.md exists at the scratch repo's main head (M1 smoke wrote it)
    const content = await source.readFile(SCRATCH_REPO, sha, "README.md");
    expect(content, "an existing file reads back non-empty").toBeTruthy();
    expect(await source.readFile(SCRATCH_REPO, sha, "guild/handoff/never-written.checks.json")).toBeNull();
  }, 120_000);
});
