/**
 * SourceCloner over the git CLI. Runs driver-side (repo-read credentials come
 * from the ambient git config — SSH key or credential helper); the resulting
 * clone directory is the ONLY thing handed to the check sandbox. Checkout is
 * always detached at the SHA — branch names are never dereferenced (D6/P7).
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ClonedSource, SourceCloner } from "../ports/validator.js";

const exec = promisify(execFile);

export class GitSourceCloner implements SourceCloner {
  /** workRoot must be a host path the container runtime can bind-mount */
  constructor(private readonly workRoot: string) {}

  async cloneAtSha(repoUrl: string, sha: string): Promise<ClonedSource> {
    const dir = await mkdtemp(join(this.workRoot, "validate-"));
    const cleanup = () => rm(dir, { recursive: true, force: true });
    try {
      await exec("git", ["clone", "--quiet", "--no-checkout", repoUrl, dir], { timeout: 120_000 });
      await exec("git", ["-C", dir, "checkout", "--quiet", "--detach", sha], { timeout: 60_000 });
      return { dir, cleanup };
    } catch (e) {
      await cleanup().catch(() => undefined);
      throw e;
    }
  }
}
