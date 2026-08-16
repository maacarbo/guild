/**
 * Drift gate for the agent-facing product manual (#7): a stale manual is
 * worse than none — an agent will confidently execute wrong instructions.
 * Every how-to in docs/AGENT-MANUAL.md must name the executed test (or
 * executable check script) that backs it, via a marker line:
 *
 *   <!-- howto: <kebab-id> | covered-by: <repo-relative path>[, <path>…] -->
 *
 * CI fails when a how-to names no covering file, names one that does not
 * exist, or names one that is not an executed test/check — so the manual
 * cannot drift from behavior without a red build.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const manualPath = join(repoRoot, "docs", "AGENT-MANUAL.md");

const MARKER = /<!--\s*howto:\s*([a-z0-9-]+)\s*\|\s*covered-by:\s*([^>]+?)\s*-->/g;
/** an executed test or check: vitest specs, cucumber step definitions + features, doctor */
const EXECUTED = /\.(test\.ts|live\.test\.ts|steps\.ts|feature)$|(^|\/)doctor\.sh$/;

function markers(): { id: string; coveredBy: string[] }[] {
  const text = readFileSync(manualPath, "utf8");
  return [...text.matchAll(MARKER)].map((m) => ({
    id: m[1]!,
    coveredBy: m[2]!.split(",").map((p) => p.trim()),
  }));
}

describe("agent manual drift gate (#7)", () => {
  it("the manual exists and carries how-to coverage markers", () => {
    expect(existsSync(manualPath)).toBe(true);
    expect(markers().length).toBeGreaterThanOrEqual(6);
  });

  it("how-to ids are unique", () => {
    const ids = markers().map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every how-to names at least one existing, executed covering file", () => {
    for (const { id, coveredBy } of markers()) {
      expect(coveredBy.length, `howto ${id} names no covering file`).toBeGreaterThan(0);
      for (const rel of coveredBy) {
        expect(existsSync(join(repoRoot, rel)), `howto ${id}: ${rel} does not exist`).toBe(true);
        expect(EXECUTED.test(rel), `howto ${id}: ${rel} is not an executed test/check`).toBe(true);
      }
    }
  });

  it("core operator flows are documented", () => {
    const ids = new Set(markers().map((m) => m.id));
    for (const required of ["submit-idea", "approve-gate", "amend-gate", "accept-stage", "emergency-stop", "check-health"]) {
      expect(ids.has(required), `missing how-to: ${required}`).toBe(true);
    }
  });
});
