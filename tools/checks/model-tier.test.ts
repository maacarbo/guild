/**
 * Cheap-tier default mirror (#67-era, operator directive 2026-08-16: guild
 * setup and testing run on the cheapest VALIDATED agentic tier): the default
 * model route is repeated at every composition seam — bin fallbacks, compose
 * interpolation defaults, smoke-step fallbacks, .env.example — and a partial
 * change would silently split the fleet across tiers. This check pins the
 * sites to ONE agreeing value that the gateway actually routes and the
 * daemon's OpenCode registry actually lists.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(repoRoot, ...p), "utf8");

function defaultsAtEverySite(): { site: string; value: string }[] {
  const sites: { site: string; value: string }[] = [];
  const grab = (site: string, text: string, re: RegExp) => {
    for (const m of text.matchAll(re)) sites.push({ site, value: m[1]! });
  };
  grab("guild-init", read("packages", "orchestrator", "src", "bin", "guild-init.ts"),
    /name: "GUILD_AGENT_MODEL".*?fallback: "([^"]+)"/gs);
  grab("guild-conductor", read("packages", "orchestrator", "src", "bin", "guild-conductor.ts"),
    /name: "GUILD_AGENT_MODEL".*?fallback: "([^"]+)"/gs);
  grab("compose", read("deploy", "compose", "docker-compose.yml"),
    /\$\{GUILD_AGENT_MODEL:-([^}]+)\}/g);
  for (const steps of ["m1-smoke", "m2a-governed-engagement", "m2b-planner-team-watchdog"]) {
    grab(steps, read("packages", "orchestrator", "features", "steps", `${steps}.steps.ts`),
      /GUILD_SMOKE_MODEL \?\? "([^"]+)"/g);
  }
  grab(".env.example", read("deploy", "compose", ".env.example"),
    /^GUILD_AGENT_MODEL=(.+)$/gm);
  return sites;
}

describe("cheap-tier default mirror", () => {
  it("every site names the same default model route", () => {
    const sites = defaultsAtEverySite();
    // presence guard: a refactor that moves a site must relocate the check, not blank it
    expect(sites.length).toBeGreaterThanOrEqual(8);
    expect(new Set(sites.map((s) => s.value)).size, JSON.stringify(sites)).toBe(1);
  });

  it("the default is a route the gateway serves and the daemon's OpenCode registry lists", () => {
    const route = defaultsAtEverySite()[0]!.value.replace(/^litellm\//, "");
    expect(read("deploy", "compose", "litellm-config.yaml")).toContain(`model_name: ${route}`);
    expect(JSON.parse(read("docker", "daemon", "opencode.json")).provider.litellm.models).toHaveProperty(route);
  });
});
