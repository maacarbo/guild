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
