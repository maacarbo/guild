/**
 * The running guild-daemon container carries the documented compose-era
 * hardening floor (#21; ARCHITECTURE.md "Compose-era hardening floor",
 * deploy/README.md Tier 1): cap_drop ALL, no-new-privileges, and
 * memory/pids limits — asserted against `docker inspect` of the live
 * stack, because the drift this guards against is precisely the compose
 * file diverging from the normative docs (GUILD_LIVE_STACK-gated).
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const live = process.env.GUILD_LIVE_STACK === "1";

interface DaemonHostConfig {
  CapDrop: string[] | null;
  SecurityOpt: string[] | null;
  Memory: number;
  PidsLimit: number | null;
}

function inspectDaemonHostConfig(): DaemonHostConfig {
  const id = execFileSync(
    "docker",
    ["ps", "--filter", "label=com.docker.compose.service=guild-daemon", "--format", "{{.ID}}"],
    { encoding: "utf8" },
  ).trim();
  if (!id) throw new Error("no running guild-daemon container found (is the compose stack up?)");
  const raw = execFileSync("docker", ["inspect", "--format", "{{json .HostConfig}}", id], {
    encoding: "utf8",
  });
  return JSON.parse(raw) as DaemonHostConfig;
}

describe.runIf(live)("guild-daemon container hardening floor (live)", () => {
  it("drops all Linux capabilities", () => {
    const host = inspectDaemonHostConfig();
    expect((host.CapDrop ?? []).map((c) => c.toUpperCase())).toContain("ALL");
  });

  it("blocks privilege escalation via no-new-privileges", () => {
    const host = inspectDaemonHostConfig();
    expect(host.SecurityOpt ?? []).toContain("no-new-privileges:true");
  });

  it("caps memory", () => {
    const host = inspectDaemonHostConfig();
    expect(host.Memory).toBeGreaterThan(0);
  });

  it("caps pids", () => {
    const host = inspectDaemonHostConfig();
    expect(host.PidsLimit ?? 0).toBeGreaterThan(0);
  });
});
