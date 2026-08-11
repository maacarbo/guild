/**
 * The stage planner (pure, D12): a deterministic template pipeline — every
 * number and word in a proposed plan traces to the idea text, the amendment
 * notes, or configuration. Guild proposes; the operator's gate move disposes.
 *
 * The planner owns derivation only. Reading upstream handoff artifacts and
 * persisting/posting plans is the conductor's job (I/O stays outside domain).
 */

import type { ContractCheck, HandoffContract, StageKind, StagePlan } from "@guild/shared";

export interface Idea {
  /** substrate external id of the idea ticket — the plan's identity anchor */
  ideaId: string;
  title: string;
  body: string;
}

export interface PlannerConfig {
  /** the Guild project = the workspace (D10) */
  projectId: string;
  /** governs when the idea names no budget: directive */
  defaultPlanBudgetCents: number;
}

/** what an upstream role may author for the next stage (D6 applied, D12 bounds) */
export interface UpstreamHandoff {
  gherkin?: string;
  checks: ContractCheck[];
}

export interface DeriveOptions {
  amendments?: string[];
  /**
   * upstream contract augmentation: `handoff` is the parsed artifact from the
   * preceding stage's validated SHA (null when absent/invalid — floor-only
   * plus a warning); authoredBy names the upstream role
   */
  upstream?: { handoff: UpstreamHandoff | null; authoredBy: string };
  /** upstream decisions that must survive the fresh-context reset (M3 automates) */
  priorDecisions?: string[];
}

export interface DerivedStage {
  plan: StagePlan;
  /** rendered into the gate body — the operator sees every degradation */
  warnings: string[];
}

export const STAGE_ORDER: readonly StageKind[] = ["analysis", "architecture", "implementation", "test", "delivery"];

const ROLE_BY_KIND: Record<StageKind, string> = {
  analysis: "analyst",
  architecture: "architect",
  implementation: "implementer",
  test: "tester",
  delivery: "implementer",
};

/** fixed integer-percent split; the remainder cents land on implementation */
const BUDGET_PCT: Record<StageKind, number> = {
  analysis: 15,
  architecture: 15,
  implementation: 40,
  test: 20,
  delivery: 10,
};

const MAX_UPSTREAM_CHECKS = 8;
const MAX_CHECK_TIMEOUT_SECONDS = 600;

export function roleFor(kind: StageKind): string {
  return ROLE_BY_KIND[kind];
}

export function handoffPathFor(kind: StageKind): string {
  return `guild/handoff/${kind}.checks.json`;
}

/**
 * `budget: $2.50`-style directive, dollars → integer cents with integer math
 * (published-language money rules: never floating-point currency). The
 * directive must be its own line — optionally after the "amend:" marker
 * ("amend: budget: 5.00") — so prose that merely ends in a budget-looking
 * phrase ("… running budget: 3") never reprices a stage (C4): amendment
 * notes replay on every re-derivation, so an accidental match would stick.
 */
export function parseBudgetDirective(text: string): number | null {
  const m = /^(?:amend:\s+)?budget:\s*\$?(\d+)(?:\.(\d{1,2}))?\s*$/m.exec(text);
  if (!m) return null;
  const dollars = Number.parseInt(m[1], 10);
  const cents = m[2] ? Number.parseInt(m[2].padEnd(2, "0"), 10) : 0;
  return dollars * 100 + cents;
}

export function planBudgetCents(idea: Idea, config: PlannerConfig): number {
  return parseBudgetDirective(idea.body) ?? config.defaultPlanBudgetCents;
}

function stageBudgetCents(total: number, kind: StageKind): number {
  const floor = (k: StageKind) => Math.floor((total * BUDGET_PCT[k]) / 100);
  if (kind !== "implementation") return floor(kind);
  const others = STAGE_ORDER.filter((k) => k !== "implementation").reduce((sum, k) => sum + floor(k), 0);
  return total - others;
}

/**
 * Shape-validate an upstream handoff artifact (hostile input — D12 bounds:
 * 1–8 checks, command timeouts ≤ 600 s). Anything off-shape rejects the WHOLE
 * artifact: a partially-honored contract would misstate what was approved.
 * Zero checks rejects too (C5): an "authored" contract with nothing the
 * tester can run would read like a real one while enforcing only the floor —
 * degrading with the missing-handoff warning states what actually happened.
 */
export function parseHandoffChecks(raw: string): UpstreamHandoff | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { gherkin, checks } = parsed as { gherkin?: unknown; checks?: unknown };
  if (gherkin !== undefined && typeof gherkin !== "string") return null;
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > MAX_UPSTREAM_CHECKS) return null;
  const valid: ContractCheck[] = [];
  for (const c of checks) {
    if (typeof c !== "object" || c === null) return null;
    const check = c as Record<string, unknown>;
    if (check.kind === "artifact" && typeof check.path === "string") {
      if (check.mustContain !== undefined && typeof check.mustContain !== "string") return null;
      valid.push({
        kind: "artifact",
        path: check.path,
        ...(check.mustContain !== undefined ? { mustContain: check.mustContain as string } : {}),
      });
      continue;
    }
    if (
      check.kind === "command" &&
      typeof check.run === "string" &&
      typeof check.expectExitCode === "number" &&
      typeof check.timeoutSeconds === "number" &&
      check.timeoutSeconds > 0 &&
      check.timeoutSeconds <= MAX_CHECK_TIMEOUT_SECONDS
    ) {
      valid.push({
        kind: "command",
        run: check.run,
        expectExitCode: check.expectExitCode,
        timeoutSeconds: check.timeoutSeconds,
        ...(typeof check.cwd === "string" ? { cwd: check.cwd } : {}),
      });
      continue;
    }
    return null;
  }
  return { ...(typeof gherkin === "string" ? { gherkin } : {}), checks: valid };
}

/** offline-capable floor checks per stage kind (D12: no dependency installation) */
function floorChecks(kind: StageKind): ContractCheck[] {
  const tests: ContractCheck = { kind: "command", run: "node --test", expectExitCode: 0, timeoutSeconds: 300 };
  switch (kind) {
    case "analysis":
      return [{ kind: "artifact", path: "docs/SPEC.md", mustContain: "## Acceptance criteria" }];
    case "architecture":
      return [{ kind: "artifact", path: "docs/DESIGN.md", mustContain: "## Modules" }];
    case "implementation":
      return [{ kind: "artifact", path: "package.json" }, tests];
    case "test":
      return [{ kind: "artifact", path: "tests/acceptance.test.mjs" }, tests];
    case "delivery":
      return [{ kind: "artifact", path: "README.md", mustContain: "## Usage" }, tests];
  }
}

function floorGherkin(kind: StageKind, idea: Idea): string {
  return [
    `Feature: ${kind} stage of "${idea.title}"`,
    `  Scenario: the ${roleFor(kind)} hands off ${kind} work that satisfies the contract checks`,
    `    Given the approved stage plan for "${idea.title}"`,
    `    When the ${roleFor(kind)} reports done`,
    `    Then every contract check passes against the pushed engagement branch`,
  ].join("\n");
}

function stageMission(kind: StageKind): string {
  switch (kind) {
    case "analysis":
      return "Analyse the idea and write the specification: docs/SPEC.md with a `## Acceptance criteria` section listing concrete, testable criteria.";
    case "architecture":
      return "Design the solution: docs/DESIGN.md with a `## Modules` section describing each module and its responsibility. Keep the design as small as the idea allows.";
    case "implementation":
      return "Implement the design: working code with a package.json, and tests that pass under `node --test`.";
    case "test":
      return "Harden the test suite: tests/acceptance.test.mjs must exercise every acceptance criterion from docs/SPEC.md; the whole suite passes under `node --test`.";
    case "delivery":
      return "Prepare the release: README.md with a `## Usage` section documenting how to run the tool; the full test suite stays green.";
  }
}

function instructionsFor(kind: StageKind, idea: Idea): string {
  const next = STAGE_ORDER[STAGE_ORDER.indexOf(kind) + 1];
  const lines = [
    stageMission(kind),
    "",
    `The idea (verbatim from the operator's ticket "${idea.title}"):`,
    idea.body,
    "",
    "Commit and push all work to your task branch. Do not merge.",
  ];
  if (next) {
    lines.push(
      "",
      `Optionally author ${handoffPathFor(next)} — acceptance checks for the ${next} stage as JSON ` +
        `{"gherkin"?: string, "checks": [{"kind":"artifact","path":...,"mustContain"?:...} | ` +
        `{"kind":"command","run":...,"expectExitCode":...,"timeoutSeconds":...}]} ` +
        `(max 8 checks, command timeouts ≤ 600s, offline-capable commands only). ` +
        `Valid checks become part of the ${next} contract the operator approves.`,
    );
  }
  return lines.join("\n");
}

/**
 * Derive one stage's plan (deterministic). Amendment notes fold into the
 * objective; a `budget:` directive in a note overrides THIS stage's budget.
 * Contract = floor ∪ upstream checks; a named-but-missing upstream handoff
 * degrades to floor-only with a warning the gate body renders.
 */
export function deriveStagePlan(
  idea: Idea,
  config: PlannerConfig,
  kind: StageKind,
  planVersion: number,
  opts: DeriveOptions = {},
): DerivedStage {
  const warnings: string[] = [];
  const amendments = opts.amendments ?? [];
  const amendedBudget = amendments.map(parseBudgetDirective).filter((b): b is number => b !== null).at(-1);
  const budgetCents = amendedBudget ?? stageBudgetCents(planBudgetCents(idea, config), kind);
  const stageId = `stg:${idea.ideaId}:${kind}`;
  const engagementId = `eng:${stageId}:v${planVersion}`;

  // A 0¢ stage mints a $0-cap virtual key and can never dispatch — `budget: 0`
  // zeroes every stage, and a sub-~10¢ plan total floors small stages to 0¢.
  // Silent 0¢ stages read as a stuck pipeline; surface it in the gate body so
  // the operator raises the `budget:` directive (C1/C2).
  if (budgetCents === 0) {
    warnings.push(
      "This stage's budget is 0¢ — its engagement key would mint with a $0 cap and can never dispatch. Raise the idea's `budget:` directive.",
    );
  }

  let authoredBy = kind === "analysis" ? "operator" : "guild-floor";
  let checks = floorChecks(kind);
  let gherkin = floorGherkin(kind, idea);
  if (opts.upstream) {
    if (opts.upstream.handoff) {
      authoredBy = opts.upstream.authoredBy;
      checks = [...checks, ...opts.upstream.handoff.checks];
      if (opts.upstream.handoff.gherkin) gherkin = `${gherkin}\n\n${opts.upstream.handoff.gherkin}`;
    } else {
      warnings.push(
        `No valid upstream handoff at ${handoffPathFor(kind)} — this contract carries Guild's floor checks only.`,
      );
    }
  }

  const contract: HandoffContract = {
    contractId: `contract:${stageId}`,
    version: planVersion,
    authoredBy,
    gherkin,
    checks,
  };

  const objective = [
    `${stageMission(kind)} Idea: ${idea.title}.`,
    ...amendments.map((a) => `Amendment: ${a}`),
  ].join(" ");

  return {
    plan: {
      projectId: config.projectId,
      stageId,
      planVersion,
      kind,
      objective,
      budgetCents,
      engagements: [
        {
          engagementId,
          role: roleFor(kind),
          title: `${kind}: ${idea.title}`,
          budgetCents,
          brief: {
            roleContext: `You are the ${roleFor(kind)} on a governed delivery team. Your work is validated against a machine-checkable contract — self-reports are never trusted.`,
            instructions: instructionsFor(kind, idea),
            contract,
            priorDecisions: opts.priorDecisions ?? [],
            artifactRefs: [],
            constraints: [
              "Zero-dependency Node.js ≥ 22 only — no npm installs; tests run offline via `node --test`.",
              "Work only inside the repository; push to your task branch; never merge or tag.",
              ...amendments,
            ],
          },
        },
      ],
    },
    warnings,
  };
}
