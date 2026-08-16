import { describe, expect, it } from "vitest";
import { ROLE_TEMPLATES, TEMPLATE_CATALOG, parseTemplateDirective, roleTemplateFor, templateFor } from "./templates.js";
import { STAGE_ORDER } from "./planner.js";

describe("the template catalog is fixed data (D12 amendment; #28 slug/kind split)", () => {
  it("standard is today's five-stage pipeline with slug == kind — existing stage ids stay byte-identical", () => {
    expect(TEMPLATE_CATALOG.standard.stages.map((s) => s.slug)).toEqual([...STAGE_ORDER]);
    for (const s of TEMPLATE_CATALOG.standard.stages) expect(s.slug).toBe(s.kind);
    expect(TEMPLATE_CATALOG.standard.stages.map((s) => s.budgetPct)).toEqual([15, 15, 40, 20, 10]);
  });

  it("quick-fix is implementation → test with slug == kind", () => {
    expect(TEMPLATE_CATALOG["quick-fix"].stages.map((s) => s.slug)).toEqual(["implementation", "test"]);
    for (const s of TEMPLATE_CATALOG["quick-fix"].stages) expect(s.slug).toBe(s.kind);
    expect(TEMPLATE_CATALOG["quick-fix"].stages.map((s) => s.budgetPct)).toEqual([70, 30]);
  });

  it("enterprise expresses two same-kind analysis stages under distinct slugs (#28, operator-ratified)", () => {
    const e = TEMPLATE_CATALOG.enterprise;
    expect(e.stages.map((s) => s.slug)).toEqual([
      "business-analysis",
      "technical-analysis",
      "architecture-security",
      "implementation",
      "test",
      "delivery",
    ]);
    expect(e.stages[0]!.kind).toBe("analysis");
    expect(e.stages[1]!.kind).toBe("analysis");
    expect(e.stages[2]!.kind).toBe("architecture");
    // the security flavor carries a mission override; the identity-bearing
    // slug is what makes two analysis-kind stages coexist
    expect(e.stages[2]!.mission).toMatch(/security/i);
  });

  it("the catalog is FIXED data — deep-frozen, so the planner's determinism is structural (audit hexagonal-7)", () => {
    expect(Object.isFrozen(TEMPLATE_CATALOG)).toBe(true);
    expect(Object.isFrozen(TEMPLATE_CATALOG.standard)).toBe(true);
    expect(Object.isFrozen(TEMPLATE_CATALOG.standard.stages)).toBe(true);
    expect(Object.isFrozen(TEMPLATE_CATALOG.enterprise.stages[0])).toBe(true);
    expect(Object.isFrozen(ROLE_TEMPLATES)).toBe(true);
  });

  it("every template: slugs unique, budget percentages sum to 100", () => {
    for (const t of Object.values(TEMPLATE_CATALOG)) {
      const slugs = t.stages.map((s) => s.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
      expect(t.stages.reduce((a, s) => a + s.budgetPct, 0)).toBe(100);
      for (const s of t.stages) expect(s.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe("role templates are catalog data (D13 global layer, M3)", () => {
  it("covers the four starter roles with a governed-team context each", () => {
    for (const role of ["analyst", "architect", "implementer", "tester"]) {
      const t = roleTemplateFor(role);
      expect(t.role).toBe(role);
      expect(t.roleContext).toContain(role);
      expect(t.roleContext).toContain("governed");
    }
  });

  it("an unknown role still yields a usable governed context — hiring never briefs blind", () => {
    const t = roleTemplateFor("security-reviewer");
    expect(t.role).toBe("security-reviewer");
    expect(t.roleContext).toContain("security-reviewer");
  });
});

describe("template: directive (same line-anchored discipline as budget:)", () => {
  it("parses a line-anchored directive", () => {
    expect(parseTemplateDirective("A tiny fix.\ntemplate: quick-fix")).toBe("quick-fix");
    expect(parseTemplateDirective("template: standard")).toBe("standard");
  });

  it("prose mentioning a template is not a directive", () => {
    expect(parseTemplateDirective("use the template: quick-fix here")).toBeNull();
    expect(parseTemplateDirective("no directive at all")).toBeNull();
  });

  it("resolves the idea's template with standard as the default", () => {
    expect(templateFor("plain idea").template.name).toBe("standard");
    expect(templateFor("fix it\ntemplate: quick-fix").template.name).toBe("quick-fix");
    expect(templateFor("big one\ntemplate: enterprise").template.name).toBe("enterprise");
  });

  it("an unknown template name degrades to standard WITH a warning the gate body renders", () => {
    const { template, warning } = templateFor("template: mega");
    expect(template.name).toBe("standard");
    expect(warning).toContain("mega");
  });
});
