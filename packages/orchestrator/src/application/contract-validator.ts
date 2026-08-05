/**
 * Contract validation use case (D6): fresh clone of the engagement work at the
 * pinned SHA — never the daemon's workspace — checks executed in the
 * least-trusted sandbox, outcome assembled by the domain rules. A moved branch
 * head changes nothing here: validation only ever sees the SHA.
 */

import type { ContractCheck, ContractVerdict, HandoffContract } from "@guild/shared";
import { assembleVerdict } from "../domain/verdict.js";
import { redactUrlCredentials } from "../domain/redact.js";
import type { CommandRunner, SourceCloner, WorkspaceReader } from "../ports/validator.js";

export interface ValidationInput {
  engagementId: string;
  contract: HandoffContract;
  repoUrl: string;
  /** the exact commit to validate — resolved once when the agent reported done */
  commitSha: string;
}

const OUTPUT_EVIDENCE_LIMIT = 1000;

export class ContractValidator {
  constructor(
    private readonly cloner: SourceCloner,
    private readonly runner: CommandRunner,
    private readonly reader: WorkspaceReader,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async validate(input: ValidationInput): Promise<ContractVerdict> {
    const ctx = {
      engagementId: input.engagementId,
      contractId: input.contract.contractId,
      contractVersion: input.contract.version,
      commitSha: input.commitSha,
      checkedAt: this.now(),
    };

    let source;
    try {
      source = await this.cloner.cloneAtSha(input.repoUrl, input.commitSha);
    } catch (e) {
      // no checks ran — infrastructure fault, retry validation, never bounce.
      // Outcome is explicit, not derived: with zero checks the derived rule
      // would read an empty result set as a vacuous pass.
      const detail = redactUrlCredentials(`clone failed: ${e instanceof Error ? e.message : String(e)}`);
      return {
        ...ctx,
        outcome: "validator_error",
        results: input.contract.checks.map((check) => ({ check, outcome: "error" as const, detail })),
      };
    }

    try {
      const results = [];
      for (const check of input.contract.checks) {
        results.push(await this.runCheck(source.dir, check));
      }
      return assembleVerdict(ctx, results);
    } finally {
      await source.cleanup().catch(() => undefined);
    }
  }

  private async runCheck(dir: string, check: ContractCheck) {
    try {
      if (check.kind === "artifact") {
        const content = await this.reader.readFile(dir, check.path);
        if (content === null) {
          return { check, outcome: "failed" as const, detail: `artifact ${check.path} does not exist` };
        }
        if (check.mustContain && !content.includes(check.mustContain)) {
          return {
            check,
            outcome: "failed" as const,
            detail: `artifact ${check.path} does not contain "${check.mustContain}"`,
          };
        }
        return { check, outcome: "passed" as const, detail: `artifact ${check.path} present` };
      }
      const run = await this.runner.runCommand(dir, check.run, check.timeoutSeconds, check.cwd);
      // check output is hostile, agent-adjacent text that lands verbatim in the
      // append-only decisions trail and on the board — a credential-bearing URL
      // echoed by any failing command must never persist in plaintext (A3)
      const evidence = redactUrlCredentials(`${run.stderr}\n${run.stdout}`.trim()).slice(0, OUTPUT_EVIDENCE_LIMIT);
      if (run.timedOut) {
        return {
          check,
          outcome: "failed" as const,
          detail: `timeout after ${check.timeoutSeconds}s: ${evidence}`.trim(),
        };
      }
      if (run.exitCode !== check.expectExitCode) {
        return {
          check,
          outcome: "failed" as const,
          detail: `exit ${run.exitCode} (expected ${check.expectExitCode}): ${evidence}`.trim(),
        };
      }
      return { check, outcome: "passed" as const, detail: `exit ${run.exitCode}` };
    } catch (e) {
      return {
        check,
        outcome: "error" as const,
        detail: redactUrlCredentials(e instanceof Error ? e.message : String(e)),
      };
    }
  }
}
