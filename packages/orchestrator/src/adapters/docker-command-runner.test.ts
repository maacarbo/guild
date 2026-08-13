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

  it("drops all Linux capabilities and forbids privilege escalation on every sandbox (A4)", () => {
    // the check command is hostile, agent-authored input; the sandbox must run
    // with no capabilities and no path to gaining any (deploy/README floor)
    const args = buildRunArgs({ image: "node:22-alpine" }, "/tmp/wr/validate-abc", "node --test", "n1");
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args[args.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
  });

  it("runs the containerized sandbox as its non-root clone owner, never uid 0 (A4)", () => {
    // the conductor's `node` user (uid 1000) creates the clone on the shared
    // named volume; the sandbox runs as that same non-root uid — able to touch
    // its own clone, holding no host-root identity
    const config = { image: "node:22-alpine", workVolume: { name: "guild-validator-work", workRoot: "/var/guild/validator-work" } };
    const args = buildRunArgs(config, "/var/guild/validator-work/validate-xyz", "node --test", "n2");
    expect(args[args.indexOf("--user") + 1]).toBe("1000:1000");
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
  });

  it("host mode runs the sandbox as the conductor's own uid — capless container-root cannot traverse the 0700 clone dir (#35)", () => {
    // mkdtemp creates the clone dir 0700; --cap-drop ALL removes DAC_OVERRIDE,
    // so container-root cannot read it (verified live 2026-08-13: every host-mode
    // command check failed "Cannot find module" while compose mode passed)
    const args = buildRunArgs({ image: "node:22-alpine" }, "/tmp/wr/validate-abc", "node --test", "n1");
    expect(args[args.indexOf("--user") + 1]).toBe(`${process.getuid!()}:${process.getgid!()}`);
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
