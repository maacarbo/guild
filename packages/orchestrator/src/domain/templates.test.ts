import { describe, expect, it } from "vitest";
import { TEMPLATE_CATALOG, parseTemplateDirective, roleTemplateFor, templateFor } from "./templates.js";
import { STAGE_ORDER } from "./planner.js";

describe("the template catalog is fixed data (D12 amendment)", () => {
  it("standard is today's five-stage pipeline verbatim", () => {
    expect(TEMPLATE_CATALOG.standard.stages).toEqual(STAGE_ORDER);
    expect(TEMPLATE_CATALOG.standard.budgetPct).toEqual({
      analysis: 15,
      architecture: 15,
      implementation: 40,
      test: 20,
      delivery: 10,
    });
  });

  it("quick-fix is implementation → test", () => {
    expect(TEMPLATE_CATALOG["quick-fix"].stages).toEqual(["implementation", "test"]);
  });

  it("every template's split covers exactly its stages and sums to 100", () => {
    for (const t of Object.values(TEMPLATE_CATALOG)) {
      expect(Object.keys(t.budgetPct).sort()).toEqual([...t.stages].sort());
      expect(Object.values(t.budgetPct).reduce((a, b) => a + b, 0)).toBe(100);
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
  });

  it("an unknown template name degrades to standard WITH a warning the gate body renders", () => {
    const { template, warning } = templateFor("template: enterprise");
    expect(template.name).toBe("standard");
    expect(warning).toContain("enterprise");
  });
});
