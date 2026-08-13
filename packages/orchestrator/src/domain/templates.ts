/**
 * Named fixed stage templates (D12 amendment, M3; slug/kind split #28): the
 * catalog is DATA — the planner stays deterministic, the choice is the
 * operator's one-word `template:` directive in the idea body (same
 * line-anchored parse discipline as `budget:`), default `standard`.
 *
 * A stage entry separates IDENTITY from BEHAVIOR (#28, operator-ratified
 * 2026-08-13): `slug` is the stage's identity within a plan (stage ids, gate
 * markers, and handoff paths derive from it), `kind` is the behavior class
 * (floor checks, mission, deliverable, default role). Two same-kind stages
 * coexist under distinct slugs — what the enterprise shape needs. The classic
 * templates keep slug == kind, so every existing stage id, gate marker, and
 * handoff path stays byte-identical: no migration.
 */

import type { StageKind } from "@guild/shared";

export interface StageEntry {
  /** stage identity within the plan — unique per template, [a-z0-9-] */
  slug: string;
  /** behavior class: selects floor checks, mission, deliverable, default role */
  kind: StageKind;
  /** integer percent of the plan budget (a template's entries sum to 100) */
  budgetPct: number;
  /** optional mission override (e.g. the security-extended architecture flavor) */
  mission?: string;
  /** optional role override; default is the kind's role */
  role?: string;
}

export interface StageTemplate {
  name: string;
  stages: readonly StageEntry[];
}

export const TEMPLATE_CATALOG: Record<string, StageTemplate> = {
  standard: {
    name: "standard",
    stages: [
      { slug: "analysis", kind: "analysis", budgetPct: 15 },
      { slug: "architecture", kind: "architecture", budgetPct: 15 },
      { slug: "implementation", kind: "implementation", budgetPct: 40 },
      { slug: "test", kind: "test", budgetPct: 20 },
      { slug: "delivery", kind: "delivery", budgetPct: 10 },
    ],
  },
  "quick-fix": {
    name: "quick-fix",
    stages: [
      { slug: "implementation", kind: "implementation", budgetPct: 70 },
      { slug: "test", kind: "test", budgetPct: 30 },
    ],
  },
  // the documented enterprise shape (D12 amendment 2026-08-04), expressible
  // since #28: two analysis-kind stages and a security-flavored architecture
  enterprise: {
    name: "enterprise",
    stages: [
      {
        slug: "business-analysis",
        kind: "analysis",
        budgetPct: 10,
        mission:
          "Analyse the business problem and write the business half of the specification: docs/SPEC.md with a `## Acceptance criteria` section capturing user-visible outcomes, constraints, and success measures — no technical design.",
      },
      {
        slug: "technical-analysis",
        kind: "analysis",
        budgetPct: 10,
        mission:
          "Refine docs/SPEC.md with the technical half: sharpen the `## Acceptance criteria` into concrete, testable criteria and record technical constraints and interfaces the design must honor.",
      },
      {
        slug: "architecture-security",
        kind: "architecture",
        budgetPct: 15,
        mission:
          "Design the solution: docs/DESIGN.md with a `## Modules` section describing each module and its responsibility, plus a `## Security` section covering trust boundaries, secrets handling, and abuse cases. Keep the design as small as the idea allows.",
      },
      { slug: "implementation", kind: "implementation", budgetPct: 35 },
      { slug: "test", kind: "test", budgetPct: 20 },
      { slug: "delivery", kind: "delivery", budgetPct: 10 },
    ],
  },
};

export interface RoleTemplate {
  role: string;
  /** the brief's roleContext — D13's GLOBAL rules layer, carried as catalog data */
  roleContext: string;
}

const governedContext = (role: string) =>
  `You are the ${role} on a governed delivery team. Your work is validated against a machine-checkable contract — self-reports are never trusted.`;

/**
 * Per-role template data (M3). The four starter roles are explicit entries so
 * their context can diverge as the catalog grows; an unknown role gets the
 * same governed context by construction — hiring must never brief blind.
 */
export const ROLE_TEMPLATES: Record<string, RoleTemplate> = Object.fromEntries(
  ["analyst", "architect", "implementer", "tester"].map((role) => [role, { role, roleContext: governedContext(role) }]),
);

export function roleTemplateFor(role: string): RoleTemplate {
  return ROLE_TEMPLATES[role] ?? { role, roleContext: governedContext(role) };
}

/** own-line directive, like parseBudgetDirective — prose never selects a template */
export function parseTemplateDirective(text: string): string | null {
  const m = /^template:\s*([a-z0-9-]+)\s*$/m.exec(text);
  return m ? m[1] : null;
}

/**
 * Resolve the idea's template; an unknown name degrades to `standard` with a
 * warning the gate body renders — the operator sees the correction at the
 * approval they were already making.
 */
export function templateFor(ideaBody: string): { template: StageTemplate; warning?: string } {
  const name = parseTemplateDirective(ideaBody);
  if (name === null) return { template: TEMPLATE_CATALOG.standard };
  const template = TEMPLATE_CATALOG[name];
  if (!template) {
    return {
      template: TEMPLATE_CATALOG.standard,
      warning: `Unknown template "${name}" — the standard pipeline applies. Available: ${Object.keys(TEMPLATE_CATALOG).join(", ")}.`,
    };
  }
  return { template };
}
