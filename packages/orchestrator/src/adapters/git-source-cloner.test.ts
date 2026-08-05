/**
 * Real-git integration test — no network, no compose stack (a local repo is
 * the "remote"), so it runs in CI. Proves the credential-hygiene contract of
 * cloneAtSha: `git clone` stores the clone URL — which embeds the scoped PAT
 * (https://x-access-token:<PAT>@host/...) — in `.git/config` as the origin
 * remote, and that clone is the ONLY thing handed to the least-trusted sandbox
 * (A2). The remote must not survive into it.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitSourceCloner } from "./git-source-cloner.js";

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

describe("GitSourceCloner (real git, no network)", () => {
  let origin: string;
  let workRoot: string;
  let sha: string;

  beforeAll(async () => {
    origin = await mkdtemp(join(tmpdir(), "guild-origin-"));
    workRoot = await mkdtemp(join(tmpdir(), "guild-work-"));
    await exec("git", ["init", "-q", "-b", "main", origin], { env: GIT_ENV });
    await exec("git", ["-C", origin, "commit", "-q", "--allow-empty", "-m", "seed"], { env: GIT_ENV });
    sha = (await exec("git", ["-C", origin, "rev-parse", "HEAD"], { env: GIT_ENV })).stdout.trim();
  });

  afterAll(async () => {
    await rm(origin, { recursive: true, force: true });
    await rm(workRoot, { recursive: true, force: true });
  });

  it("checks out the pinned SHA and strips the credential-bearing origin remote (A2)", async () => {
    const cloner = new GitSourceCloner(workRoot);
    const { dir, cleanup } = await cloner.cloneAtSha(origin, sha);
    try {
      const head = (await exec("git", ["-C", dir, "rev-parse", "HEAD"], { env: GIT_ENV })).stdout.trim();
      expect(head, "the clone is detached at the pinned SHA").toBe(sha);
      // the origin remote is where `git clone` persists the credential-bearing
      // URL — it must be gone before the clone reaches the sandbox
      const remotes = (await exec("git", ["-C", dir, "remote"], { env: GIT_ENV })).stdout.trim();
      expect(remotes, "no remote survives into the mounted clone").toBe("");
      const config = await readFile(join(dir, ".git", "config"), "utf8");
      expect(config).not.toContain("[remote ");
    } finally {
      await cleanup();
    }
  });
});
