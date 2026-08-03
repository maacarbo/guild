import { describe, expect, it } from "vitest";
import { buildRunArgs } from "./docker-command-runner.js";

describe("docker run argument construction (Tier 1 sandbox invariants)", () => {
  it("host mode bind-mounts the clone dir and runs from /work", () => {
    const args = buildRunArgs({ image: "node:22-alpine" }, "/tmp/wr/validate-abc", "node --test", "n1");
    expect(args).toContain("--network");
    expect(args).toContain("none");
    expect(args).toContain("-v");
    expect(args[args.indexOf("-v") + 1]).toBe("/tmp/wr/validate-abc:/work");
    expect(args[args.indexOf("-w") + 1]).toBe("/work");
  });

  it("host mode honors a repo-relative cwd", () => {
    const args = buildRunArgs({ image: "i" }, "/tmp/wr/validate-abc", "ls", "n1", "packages/app");
    expect(args[args.indexOf("-w") + 1]).toBe("/work/packages/app");
  });

  it("volume mode mounts the named work volume and locates the clone by relative path", () => {
    // containerized conductor (M2b): a bind path would resolve against the
    // DAEMON's host filesystem — the named volume is the only shared surface
    const config = { image: "i", workVolume: { name: "guild-validator-work", workRoot: "/var/guild/validator-work" } };
    const args = buildRunArgs(config, "/var/guild/validator-work/validate-xyz", "node --test", "n2");
    expect(args[args.indexOf("-v") + 1]).toBe("guild-validator-work:/work");
    expect(args[args.indexOf("-w") + 1]).toBe("/work/validate-xyz");
  });

  it("volume mode composes the relative clone path with a check cwd", () => {
    const config = { image: "i", workVolume: { name: "vol", workRoot: "/root" } };
    const args = buildRunArgs(config, "/root/validate-1", "ls", "n3", "sub/dir");
    expect(args[args.indexOf("-w") + 1]).toBe("/work/validate-1/sub/dir");
  });

  it("volume mode refuses a clone dir outside the work root — a silent wrong mount would run checks against nothing", () => {
    const config = { image: "i", workVolume: { name: "vol", workRoot: "/root" } };
    expect(() => buildRunArgs(config, "/elsewhere/validate-1", "ls", "n4")).toThrow(/work root/);
  });
});
