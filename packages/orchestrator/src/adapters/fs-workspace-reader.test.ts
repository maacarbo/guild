import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsWorkspaceReader } from "./fs-workspace-reader.js";

let dir: string;
const reader = new FsWorkspaceReader();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "guild-reader-"));
  await writeFile(join(dir, "PROBE.md"), "M1a P3 probe", "utf8");
});

afterAll(() => rm(dir, { recursive: true, force: true }));

describe("FsWorkspaceReader", () => {
  it("reads a repo-relative artifact from the clone", async () => {
    expect(await reader.readFile(dir, "PROBE.md")).toBe("M1a P3 probe");
  });

  it("returns null for a missing artifact", async () => {
    expect(await reader.readFile(dir, "GHOST.md")).toBeNull();
  });

  it("fails closed on a traversal escape — contracts may one day be agent-authored", async () => {
    await expect(reader.readFile(dir, "../outside.txt")).rejects.toThrow(/escapes the clone/);
    await expect(reader.readFile(dir, "a/../../outside.txt")).rejects.toThrow(/escapes the clone/);
  });
});
