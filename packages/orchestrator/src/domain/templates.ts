/**
 * Named fixed stage templates (D12 amendment, M3): the catalog is DATA — the
 * planner stays deterministic, the choice is the operator's one-word
 * `template:` directive in the idea body (same line-anchored parse discipline
 * as `budget:`), default `standard`. `enterprise` is deliberately absent —
 * deferred with its StageKind design question (#28).
 */

import type { StageKind } from "@guild/shared";

export interface StageTemplate {
  name: string;
  stages: readonly StageKind[];
  /** integer percent per stage — covers exactly `stages`, sums to 100 */
  budgetPct: Readonly<Partial<Record<StageKind, number>>>;
}

export const TEMPLATE_CATALOG: Record<string, StageTemplate> = {
  standard: {
    name: "standard",
    stages: ["analysis", "architecture", "implementation", "test", "delivery"],
    budgetPct: { analysis: 15, architecture: 15, implementation: 40, test: 20, delivery: 10 },
  },
  "quick-fix": {
    name: "quick-fix",
    stages: ["implementation", "test"],
    budgetPct: { implementation: 70, test: 30 },
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
