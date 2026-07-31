/**
 * WorkspaceReader over the clone directory. Artifact paths are repo-relative
 * by contract; resolution is confined to the clone — contracts may one day be
 * authored by planner agents, so a traversal escape must fail closed.
 */

import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { WorkspaceReader } from "../ports/validator.js";

export class FsWorkspaceReader implements WorkspaceReader {
  async readFile(cloneDir: string, path: string): Promise<string | null> {
    const root = resolve(cloneDir);
    const target = resolve(root, path);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`artifact path escapes the clone: ${path}`);
    }
    try {
      return await readFile(target, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
}
