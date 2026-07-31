/**
 * EngagementBrief → the issue body an agent starts from. The agent is
 * context-fresh (one issue per engagement, D8): everything upstream must be in
 * this text or it is lost. The acceptance contract is shown in full — criteria
 * are authored before implementation and validated automatically against the
 * pushed commit, never taken from the agent's self-report (D6).
 */

import type { ContractCheck, EngagementBrief } from "@guild/shared";

function describeCheck(check: ContractCheck): string {
  return check.kind === "command"
    ? `run \`${check.run}\` → exit ${check.expectExitCode} (timeout ${check.timeoutSeconds}s)`
    : `file \`${check.path}\` exists${check.mustContain ? ` and contains "${check.mustContain}"` : ""}`;
}

export function renderBrief(brief: EngagementBrief): string {
  const sections = [
    `## Role`,
    brief.roleContext,
    `## Instructions`,
    brief.instructions,
    ...(brief.priorDecisions.length
      ? [`## Prior decisions (binding)`, ...brief.priorDecisions.map((d) => `- ${d}`)]
      : []),
    ...(brief.artifactRefs.length
      ? [`## References`, ...brief.artifactRefs.map((r) => `- ${r}`)]
      : []),
    ...(brief.constraints.length
      ? [`## Constraints`, ...brief.constraints.map((c) => `- ${c}`)]
      : []),
    `## Acceptance contract (\`${brief.contract.contractId}\` v${brief.contract.version})`,
    "```gherkin",
    brief.contract.gherkin,
    "```",
    `Checks that will be executed:`,
    ...brief.contract.checks.map((c) => `- ${describeCheck(c)}`),
    ``,
    `When you are done, commit and push your work to your engagement branch. Your pushed commit will be validated automatically against these checks — the verdict comes from that validation, not from your report.`,
  ];
  return sections.join("\n");
}
