/**
 * The one-versions-file rule (#14, M1 standing rule): every pinned
 * third-party version lives in deploy/compose/versions.env, and every place
 * that repeats a pin (compose interpolation defaults, daemon-image ARG
 * defaults) must agree with it — CI-enforced so README, compose, and image
 * can never silently disagree. The release watcher bumps versions.env and
 * the mirrored defaults in one PR; this test is what makes a missed mirror
 * location a red build instead of a silent drift.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(repoRoot, ...p), "utf8");

function versionsEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of read("deploy", "compose", "versions.env").split("\n")) {
    const m = /^([A-Z_]+)=(.+)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

describe("one versions file (#14)", () => {
  it("declares every third-party pin", () => {
    const v = versionsEnv();
    expect(v.MULTICA_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(v.OPENCODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(v.LITELLM_IMAGE_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(v.SOCKET_PROXY_IMAGE_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("every compose interpolation default mirrors versions.env", () => {
    const v = versionsEnv();
    const compose = read("deploy", "compose", "docker-compose.yml");
    for (const m of compose.matchAll(/\$\{MULTICA_VERSION:-([^}]+)\}/g)) {
      expect(m[1]).toBe(v.MULTICA_VERSION);
    }
    expect([...compose.matchAll(/\$\{MULTICA_VERSION:-([^}]+)\}/g)].length).toBeGreaterThanOrEqual(3);
    // presence guard (audit tdd-5): a loop over zero matches asserts nothing —
    // removing or renaming the interpolation must go red, not vacuously green
    expect([...compose.matchAll(/\$\{OPENCODE_VERSION:-([^}]+)\}/g)].length).toBeGreaterThanOrEqual(1);
    for (const m of compose.matchAll(/\$\{OPENCODE_VERSION:-([^}]+)\}/g)) {
      expect(m[1]).toBe(v.OPENCODE_VERSION);
    }
  });

  it("digest-pinned images mirror versions.env", () => {
    const v = versionsEnv();
    const compose = read("deploy", "compose", "docker-compose.yml");
    expect(compose).toContain(`ghcr.io/berriai/litellm-database@${v.LITELLM_IMAGE_DIGEST}`);
    expect(compose).toContain(`tecnativa/docker-socket-proxy@${v.SOCKET_PROXY_IMAGE_DIGEST}`);
  });

  it("every GUILD_IMAGE_TAG interpolation default agrees — five sites, one tag (audit docs-8)", () => {
    const compose = read("deploy", "compose", "docker-compose.yml") + read("deploy", "compose", "docker-compose.dev.yml");
    const defaults = [...compose.matchAll(/\$\{GUILD_IMAGE_TAG:-([^}]+)\}/g)].map((m) => m[1]);
    expect(defaults.length).toBeGreaterThanOrEqual(5);
    expect(new Set(defaults).size).toBe(1);
  });

  it("daemon-image ARG defaults mirror versions.env", () => {
    const v = versionsEnv();
    const dockerfile = read("docker", "daemon", "Dockerfile");
    expect(dockerfile).toContain(`ARG MULTICA_VERSION=${v.MULTICA_VERSION}`);
    expect(dockerfile).toContain(`ARG OPENCODE_VERSION=${v.OPENCODE_VERSION}`);
  });
});
