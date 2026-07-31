/**
 * Bounce-comment rendering: a ContractVerdict → the self-contained comment
 * that resumes the implementing agent (P5: top-level comments trigger; P7:
 * session state may be gone, so the comment alone must carry the context).
 */

import type { ContractVerdict } from "@guild/shared";

function describeCheck(check: ContractVerdict["results"][number]["check"]): string {
  return check.kind === "command"
    ? `command \`${check.run}\` (expected exit ${check.expectExitCode})`
    : `artifact \`${check.path}\`${check.mustContain ? ` containing "${check.mustContain}"` : ""}`;
}

export function renderBounceComment(verdict: ContractVerdict): string {
  const failed = verdict.results.filter((r) => r.outcome === "failed");
  const lines = [
    `## Contract validation failed — rework requested`,
    ``,
    `Contract \`${verdict.contractId}\` v${verdict.contractVersion} was validated against commit \`${verdict.commitSha}\` and did not pass. Failing checks:`,
    ``,
    ...failed.map((r) => `- ${describeCheck(r.check)} — ${r.detail}`),
    ``,
    `Fix the failing checks and push your commits to the same branch you delivered on (your previous working directory may be gone — clone fresh if needed, check out that branch, and continue from its tip). Reply here when the fixes are pushed.`,
  ];
  return lines.join("\n");
}
