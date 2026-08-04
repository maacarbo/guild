/**
 * SourceControl over host git (the conductor's credentials, never the
 * agent's — D6: merges are Guild-mediated). fastForward leans on git's own
 * push semantics: pushing `<sha>:refs/heads/<target>` is refused by the
 * remote unless it is a fast-forward — the ff-only rule enforced by the tool
 * itself, not re-implemented.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { redactUrlCredentials } from "../domain/redact.js";
import type { SourceControl } from "../ports/source-control.js";

const exec = promisify(execFile);

export class GitSourceControl implements SourceControl {
  constructor(private readonly timeoutMs = 120_000) {}

  async resolveRemoteSha(repoUrl: string, branch: string): Promise<string | null> {
    const { stdout } = await exec("git", ["ls-remote", repoUrl, `refs/heads/${branch}`], {
      timeout: this.timeoutMs,
    });
    const sha = stdout.trim().split(/\s/)[0] ?? "";
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  async readFile(repoUrl: string, sha: string, path: string): Promise<string | null> {
    // full clone (no checkout) so the sha's objects are local; `git show`
    // reads the blob without materializing a working copy
    const dir = await mkdtemp(join(tmpdir(), "guild-read-"));
    try {
      await exec("git", ["clone", "--no-checkout", repoUrl, dir], { timeout: this.timeoutMs });
      const { stdout } = await exec("git", ["-C", dir, "show", `${sha}:${path}`], {
        timeout: this.timeoutMs,
        maxBuffer: 1024 * 1024,
      });
      return stdout;
    } catch {
      // missing path/sha and transport faults both degrade to floor-only
      // contracts with a rendered warning (D12) — never a crash
      return null;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async fastForward(repoUrl: string, targetBranch: string, sha: string): Promise<void> {
    // full clone (no checkout): the engagement branch's objects must be local
    // for the push; the scratch/product repos are small by construction
    const dir = await mkdtemp(join(tmpdir(), "guild-ff-"));
    try {
      await exec("git", ["clone", "--no-checkout", repoUrl, dir], { timeout: this.timeoutMs });
      await exec("git", ["-C", dir, "push", "origin", `${sha}:refs/heads/${targetBranch}`], {
        timeout: this.timeoutMs,
      });
    } catch (e) {
      const detail = redactUrlCredentials(e instanceof Error ? e.message : String(e));
      throw new Error(`fast-forward of ${targetBranch} to ${sha} failed (non-ff or transport): ${detail}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
