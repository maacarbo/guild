/**
 * The stage planner (pure, D12): a deterministic template pipeline — every
 * number and word in a proposed plan traces to the idea text, the amendment
 * notes, or configuration. Guild proposes; the operator's gate move disposes.
 *
 * The planner owns derivation only. Reading upstream handoff artifacts and
 * persisting/posting plans is the conductor's job (I/O stays outside domain).
 */

import type { ContractCheck, HandoffContract, StageKind, StagePlan } from "@guild/shared";
import { engagementIdFor, stageIdFor } from "./stage.js";
import { TEMPLATE_CATALOG, roleTemplateFor, templateFor, type StageEntry, type StageTemplate } from "./templates.js";

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
  /** the project rules file read at the run's pinned SHA (M3, D13) — folded into every brief's constraints with provenance */
  projectRules?: { path: string; sha: string; content: string };
}

export interface DerivedStage {
  plan: StagePlan;
  /** rendered into the gate body — the operator sees every degradation */
  warnings: string[];
}

/** the standard template's pipeline kinds — the catalog is the single source (M3) */
export const STAGE_ORDER: readonly StageKind[] = TEMPLATE_CATALOG.standard.stages.map((s) => s.kind);

const ROLE_BY_KIND: Record<StageKind, string> = {
  analysis: "analyst",
  architecture: "architect",
  implementation: "implementer",
  test: "tester",
  delivery: "implementer",
};

/** derived from the published language's own exhaustive map — adding a StageKind cannot leave the degrade path behind */
const KINDS: ReadonlySet<string> = new Set(Object.keys(ROLE_BY_KIND));

/**
 * Resolve a stage entry by slug against the ACTIVE template (#28). A slug the
 * current template no longer carries (e.g. the idea's template: directive was
 * edited mid-run) degrades deterministically: kind falls back to the slug
 * itself when it names a kind, else to implementation, with a 0¢ allocation —
 * the existing 0¢ gate-body warning makes the mismatch operator-visible.
 */
export function stageEntryFor(template: StageTemplate, slug: string): StageEntry {
  return (
    template.stages.find((s) => s.slug === slug) ?? {
      slug,
      kind: (KINDS.has(slug) ? slug : "implementation") as StageKind,
      budgetPct: 0,
    }
  );
}

const MAX_UPSTREAM_CHECKS = 8;
const MAX_CHECK_TIMEOUT_SECONDS = 600;

/** an entry's role: explicit override, else the kind's default (#28) */
export function roleForEntry(entry: StageEntry): string {
  return entry.role ?? ROLE_BY_KIND[entry.kind];
}

/** handoff artifacts key on the stage SLUG (#28) — slug == kind for classic templates */
export function handoffPathFor(slug: string): string {
  return `guild/handoff/${slug}.checks.json`;
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

/**
 * Per-DIRECTIVE sanity ceiling (#12, operator decision 2026-08-11): a
 * fat-fingered `budget: 999999` would mint a $999,999 virtual-key cap. The
 * clamp targets typos, not the operator's authority: it bounds ONE parsed
 * directive — the plan total when it sits in the idea body, a single stage's
 * override when it arrives in an amend note (five deliberate per-stage
 * amendments can still authorize 5x, each behind its own explicit gate
 * approval) — and the CONFIGURED default (GUILD_PLAN_BUDGET_CENTS) passes
 * through untouched: the composition root owns that trade-off.
 */
export const MAX_PLAN_BUDGET_CENTS = 10_000;

/** the amendment-note grammar — ONE definition shared by the live comment path and the reconcile recovery scan (#12) */
export function isAmendNote(text: string): boolean {
  return /^amend\b/i.test(text.trim());
}

export function planBudgetCents(idea: Idea, config: PlannerConfig): number {
  const directive = parseBudgetDirective(idea.body);
  return directive !== null ? Math.min(directive, MAX_PLAN_BUDGET_CENTS) : config.defaultPlanBudgetCents;
}

function stageBudgetCents(total: number, slug: string, template: StageTemplate): number {
  const floor = (e: StageEntry) => Math.floor((total * e.budgetPct) / 100);
  const entry = stageEntryFor(template, slug);
  // remainder cents land on the first implementation-KIND entry where the
  // template has one, else on its first stage — every template keeps the total
  const remainder = template.stages.find((e) => e.kind === "implementation") ?? template.stages[0]!;
  if (entry.slug !== remainder.slug) return floor(entry);
  const others = template.stages.filter((e) => e.slug !== remainder.slug).reduce((sum, e) => sum + floor(e), 0);
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

/**
 * An entry's acceptance floor: the catalog's per-entry override, else the
 * kind's floor (#28 catalog data; audit bdd-0 — same-kind stages need
 * discriminating floors or acceptance fast-forward auto-satisfies the later
 * stage's contract with the earlier stage's artifact).
 */
function floorChecksFor(entry: StageEntry): ContractCheck[] {
  if (!entry.floor) return floorChecks(entry.kind);
  return entry.floor.map((f) => ({ kind: "artifact", path: f.path, mustContain: f.mustContain }));
}

function floorGherkin(entry: StageEntry, idea: Idea): string {
  // slug and entry role (#28) — byte-identical to the old kind/role text for
  // classic templates, distinct per stage for enterprise
  const role = roleForEntry(entry);
  return [
    `Feature: ${entry.slug} stage of "${idea.title}"`,
    `  Scenario: the ${role} hands off ${entry.slug} work that satisfies the contract checks`,
    `    Given the approved stage plan for "${idea.title}"`,
    `    When the ${role} reports done`,
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

/** the artifact a stage itself produces — what its contract checks may touch (#35) */
function stageDeliverable(kind: StageKind): string {
  switch (kind) {
    case "analysis":
      return "docs/SPEC.md";
    case "architecture":
      return "design documents under docs/ (docs/DESIGN.md)";
    case "implementation":
      return "working code with a package.json and tests passing under `node --test`";
    case "test":
      return "tests/acceptance.test.mjs and the passing suite";
    case "delivery":
      return "README.md and the green suite";
  }
}

/** an entry's mission: explicit override, else the kind's default (#28) */
function missionFor(entry: StageEntry): string {
  return entry.mission ?? stageMission(entry.kind);
}

function instructionsFor(entry: StageEntry, idea: Idea, template: StageTemplate): string {
  // next stage per the ACTIVE template — briefing a role to author checks for
  // a stage the template never runs would be dead instruction (#35)
  const index = template.stages.findIndex((s) => s.slug === entry.slug);
  const next = index >= 0 ? template.stages[index + 1] : undefined;
  const lines = [
    missionFor(entry),
    "",
    `The idea (verbatim from the operator's ticket "${idea.title}"):`,
    idea.body,
    "",
    "Commit and push all work to your task branch. Do not merge.",
  ];
  if (next) {
    lines.push(
      "",
      `Optionally author ${handoffPathFor(next.slug)} — acceptance checks for the ${next.slug} stage as JSON ` +
        `{"gherkin"?: string, "checks": [{"kind":"artifact","path":...,"mustContain"?:...} | ` +
        `{"kind":"command","run":...,"expectExitCode":...,"timeoutSeconds":...}]} ` +
        `(max 8 checks, command timeouts ≤ 600s, offline-capable commands only). ` +
        `These checks gate the ${next.slug} stage itself, so every check must be satisfiable by that stage's own ` +
        `deliverable — ${stageDeliverable(next.kind)} — never by artifacts of later stages: a check that executes ` +
        `not-yet-written code cannot pass and forces the ${next.slug} stage into bounce escalation. ` +
        `Valid checks become part of the ${next.slug} contract the operator approves.`,
    );
  }
  return lines.join("\n");
}

/**
 * Stages whose whole deliverable lives under docs/ — an upstream check that
 * reaches outside can only be satisfied by later stages' work, so the gate
 * body warns the operator before approval (#35, D12 refinement). Advisory
 * only: the check still merges; the operator amends or bounces with guidance.
 */
const DOCS_ONLY_STAGES: ReadonlySet<StageKind> = new Set(["analysis", "architecture"]);

/** inside docs/ with no ../ traversal — a docs/-prefix alone proves nothing */
function withinDocs(path: string): boolean {
  return path.startsWith("docs/") && !path.split("/").includes("..");
}

/** first path-like token outside docs/ in a check, or null when clean */
function outsideDocsReference(check: ContractCheck): string | null {
  if (check.kind === "artifact") return withinDocs(check.path) ? null : check.path;
  for (const raw of check.run.split(/\s+/)) {
    const token = raw.replace(/^["']+|["']+$/g, "");
    if (token.startsWith("-") || withinDocs(token)) continue;
    // path-like: contains a separator, or ends in a real file extension
    if (token.includes("/") || /\.[a-z][a-z0-9]*$/i.test(token)) return token;
  }
  return null;
}

/**
 * Derive one stage's plan (deterministic). The stage selector is the entry
 * SLUG (#28 — slug == kind for classic templates, so existing callers and
 * persisted ids are untouched). Amendment notes fold into the objective; a
 * `budget:` directive in a note overrides THIS stage's budget. Contract =
 * floor ∪ upstream checks; a named-but-missing upstream handoff degrades to
 * floor-only with a warning the gate body renders.
 */
export function deriveStagePlan(
  idea: Idea,
  config: PlannerConfig,
  slug: string,
  planVersion: number,
  opts: DeriveOptions = {},
): DerivedStage {
  const warnings: string[] = [];
  const { template, warning: templateWarning } = templateFor(idea.body);
  if (templateWarning) warnings.push(templateWarning);
  const entry = stageEntryFor(template, slug);
  const kind = entry.kind;
  const amendments = opts.amendments ?? [];
  const amendedBudgetRaw = amendments.map(parseBudgetDirective).filter((b): b is number => b !== null).at(-1);
  const amendedBudget = amendedBudgetRaw !== undefined ? Math.min(amendedBudgetRaw, MAX_PLAN_BUDGET_CENTS) : undefined;
  const budgetCents = amendedBudget ?? stageBudgetCents(planBudgetCents(idea, config), slug, template);
  const ideaDirective = parseBudgetDirective(idea.body);
  const clampedRaw = amendedBudgetRaw !== undefined ? amendedBudgetRaw : ideaDirective;
  if (clampedRaw !== null && clampedRaw !== undefined && clampedRaw > MAX_PLAN_BUDGET_CENTS) {
    warnings.push(
      `The budget: directive (${clampedRaw}¢) exceeds the ${MAX_PLAN_BUDGET_CENTS}¢ sanity ceiling and was clamped — raise MAX_PLAN_BUDGET_CENTS deliberately if this was intended (#12).`,
    );
  }
  const stageId = stageIdFor(idea.ideaId, entry.slug);
  const engagementId = engagementIdFor(stageId, planVersion);

  // A 0¢ stage mints a $0-cap virtual key and can never dispatch — `budget: 0`
  // zeroes every stage, and a sub-~10¢ plan total floors small stages to 0¢.
  // Silent 0¢ stages read as a stuck pipeline; surface it in the gate body so
  // the operator raises the `budget:` directive (C1/C2).
  if (budgetCents === 0) {
    warnings.push(
      "This stage's budget is 0¢ — its engagement key would mint with a $0 cap and can never dispatch. Raise the idea's `budget:` directive.",
    );
  }

  // the FIRST template stage is authored by the operator (the idea is its
  // upstream artifact) regardless of kind — under enterprise that is
  // business-analysis, not the analysis kind per se
  const isFirst = template.stages[0]?.slug === entry.slug;
  let authoredBy = isFirst ? "operator" : "guild-floor";
  let checks = floorChecksFor(entry);
  let gherkin = floorGherkin(entry, idea);
  if (opts.upstream) {
    if (opts.upstream.handoff) {
      authoredBy = opts.upstream.authoredBy;
      checks = [...checks, ...opts.upstream.handoff.checks];
      if (opts.upstream.handoff.gherkin) gherkin = `${gherkin}\n\n${opts.upstream.handoff.gherkin}`;
      if (DOCS_ONLY_STAGES.has(kind)) {
        for (const check of opts.upstream.handoff.checks) {
          const offender = outsideDocsReference(check);
          if (offender !== null) {
            warnings.push(
              `Upstream check references "${offender}" outside docs/ — the ${kind} stage delivers documents only, ` +
                `so this check may only be satisfiable by later stages' work and would bounce to escalation (#35). ` +
                `Amend or bounce with guidance before approving.`,
            );
          }
        }
      }
    } else {
      warnings.push(
        `No valid upstream handoff at ${handoffPathFor(entry.slug)} — this contract carries Guild's floor checks only.`,
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
    `${missionFor(entry)} Idea: ${idea.title}.`,
    ...amendments.map((a) => `Amendment: ${a}`),
  ].join(" ");

  const role = roleForEntry(entry);
  return {
    plan: {
      projectId: config.projectId,
      stageId,
      slug: entry.slug,
      planVersion,
      kind,
      objective,
      budgetCents,
      engagements: [
        {
          engagementId,
          role,
          title: `${entry.slug}: ${idea.title}`,
          budgetCents,
          brief: {
            roleContext: roleTemplateFor(role).roleContext,
            instructions: instructionsFor(entry, idea, template),
            contract,
            priorDecisions: opts.priorDecisions ?? [],
            artifactRefs: [],
            constraints: [
              "Zero-dependency Node.js ≥ 22 only — no npm installs; tests run offline via `node --test`.",
              "Work only inside the repository; push to your task branch; never merge or tag.",
              ...(opts.projectRules
                ? [`Project rules (${opts.projectRules.path} @ ${opts.projectRules.sha.slice(0, 8)}):\n${opts.projectRules.content}`]
                : []),
              ...amendments,
            ],
          },
        },
      ],
    },
    warnings,
  };
}
