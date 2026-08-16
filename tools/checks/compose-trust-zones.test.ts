/**
 * Compose network trust zones (#57, ROADMAP hardening floor): all databases
 * live ONLY on the internal `guild-data` network — no host publishing, no
 * external route, unreachable from the daemon (which runs LLM-generated
 * code). The daemon sits on `guild-dev` alone; services that genuinely span
 * zones (backend, gateway, conductor) are dual-homed. CI-enforced so a
 * compose edit cannot silently flatten the zones back.
 *
 * Parsing note: no YAML dependency in this checks project — the assertions
 * work on the two compose files' text with anchored regexes over the
 * one-service-one-`networks:`-line layout this repo keeps. A layout change
 * that breaks the regex fails the test loudly (toMatch on undefined), never
 * silently.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const compose = readFileSync(join(repoRoot, "deploy", "compose", "docker-compose.yml"), "utf8");
const devCompose = readFileSync(join(repoRoot, "deploy", "compose", "docker-compose.dev.yml"), "utf8");

/** the `networks: [...]` list of one service block in the base file */
function networksOf(service: string): string[] {
  const block = new RegExp(`^  ${service}:\\n(?:^(?:    | *$).*\\n)+?^    networks: \\[([^\\]]+)\\]`, "m").exec(compose);
  expect(block, `service ${service} with a networks list`).not.toBeNull();
  return block![1]!.split(",").map((n) => n.trim());
}

describe("compose network trust zones (#57)", () => {
  it("guild-data exists and is internal — no gateway, no published ports possible through it", () => {
    expect(compose).toMatch(/^  guild-data:\n(?:    .*\n)*?    internal: true$/m);
  });

  it("every database sits ONLY on guild-data — the daemon has no route to any Postgres", () => {
    for (const db of ["multica-postgres", "litellm-postgres", "guild-postgres"]) {
      expect(networksOf(db), db).toEqual(["guild-data"]);
    }
  });

  it("the daemon stays on guild-dev alone — backend and gateway reach it, the data zone never does", () => {
    expect(networksOf("guild-daemon")).toEqual(["guild-dev"]);
  });

  it("zone-spanning services are dual-homed: backend and gateway bridge dev and data; the conductor adds the validator zone", () => {
    expect(networksOf("multica-backend").sort()).toEqual(["guild-data", "guild-dev"]);
    expect(networksOf("litellm").sort()).toEqual(["guild-data", "guild-dev"]);
    expect(networksOf("guild-conductor").sort()).toEqual(["guild-data", "guild-dev", "guild-validate"]);
    expect(networksOf("guild-kill").sort()).toEqual(["guild-data", "guild-dev"]);
  });

  it("no database publishes a host port in the base file — the dev harness's loopback 5442 lives only in the override", () => {
    for (const db of ["multica-postgres", "litellm-postgres", "guild-postgres"]) {
      const block = new RegExp(`^  ${db}:\\n(?:^    .*\\n|^ *\\n)+?(?=^  \\S)`, "m").exec(compose + "\n  END:\n");
      expect(block![0], db).not.toContain("ports:");
    }
    expect(devCompose).toContain("127.0.0.1:5442:5432");
  });

  it("the override's publish rides a dev-only harness network — NEVER guild-dev, which would hand the daemon its route back (live-proven 2026-08-16)", () => {
    expect(devCompose).toMatch(/guild-postgres:\n(?:.*\n)*?    networks: \[guild-data, guild-harness\]/);
    expect(devCompose).not.toMatch(/networks: \[[^\]]*guild-dev[^\]]*\]/);
    // the harness net exists, is not internal, and only guild-postgres joins it
    expect(devCompose).toMatch(/^networks:\n(?:.*\n)*?  guild-harness:/m);
    expect(devCompose).not.toMatch(/guild-harness:\n(?:    .*\n)*?    internal: true/);
  });
});
