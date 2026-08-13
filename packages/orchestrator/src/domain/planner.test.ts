import { describe, expect, it } from "vitest";
import type { ContractCheck } from "@guild/shared";
import {
  STAGE_ORDER,
  deriveStagePlan,
  handoffPathFor,
  parseBudgetDirective,
  parseHandoffChecks,
  planBudgetCents,
  roleFor,
  type Idea,
  type PlannerConfig,
} from "./planner.js";

const idea: Idea = {
  ideaId: "94440df3",
  title: "Idea: word-count utility",
  body: "A CLI that counts words in a file.",
};
const config: PlannerConfig = { projectId: "ws-1", defaultPlanBudgetCents: 1000 };

describe("the fixed pipeline (D12)", () => {
  it("orders the five stages analysis → architecture → implementation → test → delivery", () => {
    expect(STAGE_ORDER).toEqual(["analysis", "architecture", "implementation", "test", "delivery"]);
  });

  it("maps the four-role starter team; delivery runs on the implementer", () => {
    expect(STAGE_ORDER.map(roleFor)).toEqual(["analyst", "architect", "implementer", "tester", "implementer"]);
  });
});

describe("budget allocation is mechanical (D12)", () => {
  it("uses the configured default when the idea names no budget", () => {
    expect(planBudgetCents(idea, config)).toBe(1000);
  });

  it("parses a budget: directive in dollars to integer cents — never floating currency", () => {
    expect(parseBudgetDirective("some text\nbudget: 2.50\nmore")).toBe(250);
    expect(parseBudgetDirective("budget: $3")).toBe(300);
    expect(parseBudgetDirective("budget: 0.05")).toBe(5);
  });

  it("ignores malformed directives — the default governs", () => {
    expect(parseBudgetDirective("budget: lots")).toBeNull();
    expect(parseBudgetDirective("no directive")).toBeNull();
    expect(planBudgetCents({ ...idea, body: "budget: much" }, config)).toBe(1000);
  });

  it("a fat-fingered directive is clamped to the plan ceiling and the gate body warns (#12)", () => {
    const huge = { ...idea, body: "budget: 999999" };
    expect(planBudgetCents(huge, config)).toBe(10000);
    const { plan, warnings } = deriveStagePlan(huge, config, "test", 1);
    expect(plan.budgetCents).toBe(2000); // 20% of the clamped $100 total
    expect(warnings.some((w) => w.includes("ceiling"))).toBe(true);
  });

  it("the ceiling clamps directives only — the CONFIGURED default passes through untouched (#12)", () => {
    const generous = { ...config, defaultPlanBudgetCents: 25000 };
    expect(planBudgetCents(idea, generous)).toBe(25000);
    const { warnings } = deriveStagePlan(idea, generous, "test", 1);
    expect(warnings.some((w) => w.includes("ceiling"))).toBe(false);
  });

  it("an amendment budget: override is clamped to the same ceiling with a warning (#12)", () => {
    const { plan, warnings } = deriveStagePlan(idea, config, "test", 2, {
      amendments: ["amend: budget: 500.00"],
    });
    expect(plan.budgetCents).toBe(10000);
    expect(warnings.some((w) => w.includes("ceiling"))).toBe(true);
  });

  it("prose ending in a budget-looking phrase is not a directive — only a line-anchored budget: reprices (C4)", () => {
    expect(parseBudgetDirective("amend: reduced scope; running budget: 3")).toBeNull();
    expect(parseBudgetDirective("we cut the running budget: 3")).toBeNull();
    const { plan } = deriveStagePlan(idea, config, "test", 2, {
      amendments: ["amend: reduced scope; running budget: 3"],
    });
    expect(plan.budgetCents).toBe(200);
  });

  it("a quick-fix idea splits 70/30 across its two stages with the remainder on implementation (M3 templates)", () => {
    const quick = { ...idea, body: "A tiny fix.\ntemplate: quick-fix\nbudget: 1.01" };
    const impl = deriveStagePlan(quick, config, "implementation", 1).plan.budgetCents;
    const test = deriveStagePlan(quick, config, "test", 1).plan.budgetCents;
    expect(test).toBe(30); // floor(101 * 30%)
    expect(impl).toBe(71); // 70% + remainder cent
  });

  it("splits 15/15/40/20/10 in integer cents with the remainder on implementation", () => {
    const stages = STAGE_ORDER.map((kind) => deriveStagePlan(idea, config, kind, 1).plan);
    expect(stages.map((s) => s.budgetCents)).toEqual([150, 150, 400, 200, 100]);
    const odd = STAGE_ORDER.map(
      (kind) => deriveStagePlan({ ...idea, body: "budget: 9.99" }, config, kind, 1).plan.budgetCents,
    );
    // floors: 149/149/399/199/99 = 995; remainder 4 lands on implementation
    expect(odd).toEqual([149, 149, 403, 199, 99]);
    expect(odd.reduce((a, b) => a + b)).toBe(999);
  });

  it("the engagement inherits the stage budget — one engagement per stage in v1", () => {
    const { plan } = deriveStagePlan(idea, config, "implementation", 1);
    expect(plan.engagements).toHaveLength(1);
    expect(plan.engagements[0].budgetCents).toBe(plan.budgetCents);
  });

  it("warns when a stage budget rounds to 0¢ — `budget: 0` and sub-10¢ totals can never dispatch (C1/C2)", () => {
    // budget: 0 -> every stage 0¢ (C1)
    const zero = deriveStagePlan({ ...idea, body: "budget: 0" }, config, "analysis", 1);
    expect(zero.plan.budgetCents).toBe(0);
    expect(zero.warnings.some((w) => /0¢/.test(w))).toBe(true);
    // budget: 0.03 -> analysis floors to 0¢ while implementation still funds (C2)
    const tiny = deriveStagePlan({ ...idea, body: "budget: 0.03" }, config, "analysis", 1);
    expect(tiny.plan.budgetCents).toBe(0);
    expect(tiny.warnings.some((w) => /0¢/.test(w))).toBe(true);
    // a funded stage stays warning-free
    const funded = deriveStagePlan(idea, config, "implementation", 1);
    expect(funded.warnings.some((w) => /0¢/.test(w))).toBe(false);
  });
});

describe("identity and versioning", () => {
  it("stage, engagement, and contract identities embed the idea, kind, and plan version", () => {
    const { plan } = deriveStagePlan(idea, config, "analysis", 2);
    expect(plan.projectId).toBe("ws-1");
    expect(plan.stageId).toBe("stg:94440df3:analysis");
    expect(plan.planVersion).toBe(2);
    expect(plan.engagements[0].engagementId).toBe("eng:stg:94440df3:analysis:v2");
    expect(plan.engagements[0].brief.contract.version).toBe(2);
  });

  it("objective carries the idea title and body", () => {
    const { plan } = deriveStagePlan(idea, config, "analysis", 1);
    expect(plan.objective).toContain("word-count utility");
  });
});

describe("amendment re-derivation (D12: re-gate on amendment)", () => {
  it("folds the note into the objective and bumps nothing it should not", () => {
    const { plan } = deriveStagePlan(idea, config, "analysis", 2, {
      amendments: ["amend: also count characters"],
    });
    expect(plan.objective).toContain("also count characters");
    expect(plan.planVersion).toBe(2);
  });

  it("a budget: directive in the note overrides THIS stage's budget", () => {
    const { plan } = deriveStagePlan(idea, config, "test", 2, { amendments: ["amend: budget: 5.00"] });
    expect(plan.budgetCents).toBe(500);
    expect(plan.engagements[0].budgetCents).toBe(500);
  });
});

describe("floor contracts are offline-capable (D12)", () => {
  it("every stage gets a floor contract; commands never require dependency installation", () => {
    for (const kind of STAGE_ORDER) {
      const { plan } = deriveStagePlan(idea, config, kind, 1);
      const contract = plan.engagements[0].brief.contract;
      expect(contract.checks.length).toBeGreaterThan(0);
      for (const check of contract.checks) {
        if (check.kind === "command") {
          expect(check.run).not.toMatch(/npm |pnpm |yarn |npx /);
          expect(check.timeoutSeconds).toBeLessThanOrEqual(600);
        }
      }
    }
  });

  it("analysis demands the spec artifact with acceptance criteria; authored by the operator (the idea is upstream)", () => {
    const { plan } = deriveStagePlan(idea, config, "analysis", 1);
    const contract = plan.engagements[0].brief.contract;
    expect(contract.authoredBy).toBe("operator");
    expect(contract.checks).toContainEqual({
      kind: "artifact",
      path: "docs/SPEC.md",
      mustContain: "## Acceptance criteria",
    });
  });

  it("implementation and test both prove node --test green", () => {
    for (const kind of ["implementation", "test"] as const) {
      const { plan } = deriveStagePlan(idea, config, kind, 1);
      const commands = plan.engagements[0].brief.contract.checks.filter((c) => c.kind === "command");
      expect(commands.some((c) => c.kind === "command" && c.run.includes("node --test"))).toBe(true);
    }
  });
});

describe("upstream-authored augmentation (D6 applied — parseHandoffChecks bounds)", () => {
  const good = JSON.stringify({
    gherkin: "Feature: counting",
    checks: [{ kind: "artifact", path: "src/count.mjs" }],
  });

  it("valid handoff JSON parses; the derived contract unions floor and upstream checks and names the author", () => {
    const upstream = parseHandoffChecks(good);
    expect(upstream).not.toBeNull();
    const { plan, warnings } = deriveStagePlan(idea, config, "implementation", 1, {
      upstream: { handoff: upstream!, authoredBy: "architect" },
    });
    const contract = plan.engagements[0].brief.contract;
    expect(contract.authoredBy).toBe("architect");
    expect(contract.checks).toContainEqual({ kind: "artifact", path: "src/count.mjs" });
    expect(contract.checks.some((c) => c.kind === "command" && c.run.includes("node --test"))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("invalid JSON, wrong shapes, oversize check lists, and oversize timeouts are rejected wholesale", () => {
    expect(parseHandoffChecks("not json {")).toBeNull();
    expect(parseHandoffChecks(JSON.stringify({ checks: "nope" }))).toBeNull();
    expect(
      parseHandoffChecks(
        JSON.stringify({ checks: Array.from({ length: 9 }, (_, i) => ({ kind: "artifact", path: `f${i}` })) }),
      ),
    ).toBeNull();
    expect(
      parseHandoffChecks(
        JSON.stringify({ checks: [{ kind: "command", run: "sleep 1", expectExitCode: 0, timeoutSeconds: 601 }] }),
      ),
    ).toBeNull();
  });

  it("a handoff with zero checks is rejected wholesale — nothing enforceable was authored (C5)", () => {
    expect(parseHandoffChecks(JSON.stringify({ checks: [] }))).toBeNull();
    expect(parseHandoffChecks(JSON.stringify({ gherkin: "Feature: counting", checks: [] }))).toBeNull();
  });

  it("a missing upstream handoff derives floor-only with a rendered warning", () => {
    const { plan, warnings } = deriveStagePlan(idea, config, "implementation", 1, {
      upstream: { handoff: null, authoredBy: "architect" },
    });
    expect(plan.engagements[0].brief.contract.authoredBy).toBe("guild-floor");
    expect(warnings.some((w) => w.includes(handoffPathFor("implementation")))).toBe(true);
  });

  it("names the well-known handoff path per stage kind", () => {
    expect(handoffPathFor("architecture")).toBe("guild/handoff/architecture.checks.json");
  });
});

describe("stage-inappropriate upstream checks warn in the gate body (#35, D12 refinement)", () => {
  const upstreamOf = (checks: ContractCheck[]) => ({
    upstream: { handoff: { checks }, authoredBy: "analyst" },
  });

  it("an architecture-stage command check executing files outside docs/ warns — and still merges", () => {
    const { plan, warnings } = deriveStagePlan(idea, config, "architecture", 1, {
      ...upstreamOf([{ kind: "command", run: "node bin/wc.mjs --help", expectExitCode: 0, timeoutSeconds: 60 }]),
    });
    expect(warnings.some((w) => w.includes("bin/wc.mjs") && w.includes("outside docs/"))).toBe(true);
    expect(plan.engagements[0].brief.contract.checks.some((c) => c.kind === "command" && c.run.includes("bin/wc.mjs"))).toBe(true);
  });

  it("an architecture-stage artifact check outside docs/ warns", () => {
    const { warnings } = deriveStagePlan(idea, config, "architecture", 1, {
      ...upstreamOf([{ kind: "artifact", path: "src/wc.mjs" }]),
    });
    expect(warnings.some((w) => w.includes("src/wc.mjs") && w.includes("outside docs/"))).toBe(true);
  });

  it("a docs/-prefixed traversal does not slip the warning (docs/../src)", () => {
    const { warnings } = deriveStagePlan(idea, config, "architecture", 1, {
      ...upstreamOf([
        { kind: "artifact", path: "docs/../src/wc.mjs" },
        { kind: "command", run: "node docs/../bin/wc.mjs", expectExitCode: 0, timeoutSeconds: 60 },
      ]),
    });
    expect(warnings.filter((w) => w.includes("outside docs/")).length).toBe(2);
  });

  it("architecture checks against docs/ raise no warning", () => {
    const { warnings } = deriveStagePlan(idea, config, "architecture", 1, {
      ...upstreamOf([
        { kind: "artifact", path: "docs/DESIGN.md", mustContain: "## Modules" },
        { kind: "command", run: "grep -q '## Modules' docs/DESIGN.md", expectExitCode: 0, timeoutSeconds: 60 },
      ]),
    });
    expect(warnings.some((w) => w.includes("outside docs/"))).toBe(false);
  });

  it("implementation-stage checks executing code are stage-appropriate — no warning", () => {
    const { warnings } = deriveStagePlan(idea, config, "implementation", 1, {
      upstream: {
        handoff: { checks: [{ kind: "command", run: "node bin/wc.mjs README.md", expectExitCode: 0, timeoutSeconds: 60 }] },
        authoredBy: "architect",
      },
    });
    expect(warnings.some((w) => w.includes("outside docs/"))).toBe(false);
  });
});

describe("enterprise template derivation (#28: slug carries identity, kind carries behavior)", () => {
  const enterprise = { ...idea, body: "A big idea.\ntemplate: enterprise\nbudget: 10.00" };

  it("two analysis-kind stages coexist under distinct slugs with distinct stage ids and handoff paths", () => {
    const biz = deriveStagePlan(enterprise, config, "business-analysis", 1).plan;
    const tech = deriveStagePlan(enterprise, config, "technical-analysis", 1).plan;
    expect(biz.stageId).toBe(`stg:${idea.ideaId}:business-analysis`);
    expect(tech.stageId).toBe(`stg:${idea.ideaId}:technical-analysis`);
    expect(biz.kind).toBe("analysis");
    expect(tech.kind).toBe("analysis");
    // business-analysis briefs the NEXT stage's handoff by SLUG
    expect(biz.engagements[0]!.brief.instructions).toContain("guild/handoff/technical-analysis.checks.json");
  });

  it("a mission override flows into the objective and instructions; floor checks stay kind-derived", () => {
    const { plan } = deriveStagePlan(enterprise, config, "architecture-security", 1);
    expect(plan.objective).toMatch(/## Security/);
    expect(plan.engagements[0]!.brief.instructions).toMatch(/trust boundaries/);
    expect(plan.engagements[0]!.brief.contract.checks.some((c) => c.kind === "artifact" && c.path === "docs/DESIGN.md")).toBe(true);
  });

  it("the FIRST template stage is operator-authored regardless of slug; budget splits by entry percent", () => {
    const { plan } = deriveStagePlan(enterprise, config, "business-analysis", 1);
    expect(plan.engagements[0]!.brief.contract.authoredBy).toBe("operator");
    expect(plan.budgetCents).toBe(100); // 10% of $10.00
  });
});

describe("project rules fold into briefs (M3, D13)", () => {
  it("rules constraint carries provenance and content verbatim", () => {
    const { plan } = deriveStagePlan(idea, config, "test", 1, {
      projectRules: { path: "AGENTS.md", sha: "sha-rules-123", content: "Never commit secrets.\nPrefer small diffs." },
    });
    const c = plan.engagements[0]!.brief.constraints;
    expect(c.some((x) => x.includes("AGENTS.md @ sha-rule") && x.includes("Never commit secrets."))).toBe(true);
  });

  it("no rules, no constraint — the global layer stands alone", () => {
    const { plan } = deriveStagePlan(idea, config, "test", 1, {});
    expect(plan.engagements[0]!.brief.constraints.some((x) => x.includes("AGENTS.md"))).toBe(false);
  });
});

describe("briefs carry what fresh context needs (D6/M2b: priorDecisions ride explicitly)", () => {
  it("instructions tell the role to author the NEXT stage's handoff checks — delivery has no successor", () => {
    for (const [i, kind] of STAGE_ORDER.entries()) {
      const { plan } = deriveStagePlan(idea, config, kind, 1);
      const instructions = plan.engagements[0].brief.instructions;
      const next = STAGE_ORDER[i + 1];
      if (next) expect(instructions).toContain(handoffPathFor(next));
      else expect(instructions).not.toContain("guild/handoff/");
    }
  });

  it("handoff authoring demands checks satisfiable by the NEXT stage's own deliverable (#35)", () => {
    const deliverableAnchor: Record<string, string> = {
      architecture: "docs/DESIGN.md",
      implementation: "package.json",
      test: "tests/acceptance.test.mjs",
      delivery: "README.md",
    };
    for (const [i, kind] of STAGE_ORDER.entries()) {
      const next = STAGE_ORDER[i + 1];
      if (!next) continue;
      const instructions = deriveStagePlan(idea, config, kind, 1).plan.engagements[0].brief.instructions;
      expect(instructions).toContain(deliverableAnchor[next]);
      expect(instructions).toMatch(/never by artifacts of later stages/);
    }
  });

  it("the quick-fix tester is not told to author checks for a stage the template does not run (#35)", () => {
    const quickFix = { ...idea, body: "template: quick-fix\nA tiny fix." };
    const instructions = deriveStagePlan(quickFix, config, "test", 1).plan.engagements[0].brief.instructions;
    expect(instructions).not.toContain("guild/handoff/");
  });

  it("constraints pin the offline floor: zero-dependency Node, node --test", () => {
    const { plan } = deriveStagePlan(idea, config, "implementation", 1);
    expect(plan.engagements[0].brief.constraints.join(" ")).toMatch(/zero.dependency|no dependencies/i);
  });

  it("priorDecisions pass through into the brief", () => {
    const { plan } = deriveStagePlan(idea, config, "architecture", 1, {
      priorDecisions: ["analysis validated at abc123"],
    });
    expect(plan.engagements[0].brief.priorDecisions).toEqual(["analysis validated at abc123"]);
  });
});

// the checks type stays honest: parseHandoffChecks output is assignable to ContractCheck[]
const _typecheck: ContractCheck[] | undefined = parseHandoffChecks('{"checks":[]}')?.checks;
void _typecheck;
