// The Guild conductor: stage planner, approval gate, contract validator,
// budget watchdog — hexagonal per D7, substrate behind the ExecutionSubstrate
// port per D8. M1b ships the first slice: the contract validator with the
// docker-run driver (D6 least-trusted sandbox). See docs/ROADMAP.md.

import { ContractValidator } from "./application/contract-validator.js";
import { DockerCommandRunner } from "./adapters/docker-command-runner.js";
import { FsWorkspaceReader } from "./adapters/fs-workspace-reader.js";
import { GitSourceCloner } from "./adapters/git-source-cloner.js";

export { ContractValidator, type ValidationInput } from "./application/contract-validator.js";
export { assembleVerdict, type VerdictContext } from "./domain/verdict.js";
export type { ClonedSource, CommandOutcome, CommandRunner, SourceCloner, WorkspaceReader } from "./ports/validator.js";
export { DockerCommandRunner, type DockerRunnerConfig } from "./adapters/docker-command-runner.js";
export { FsWorkspaceReader } from "./adapters/fs-workspace-reader.js";
export { GitSourceCloner } from "./adapters/git-source-cloner.js";

export interface ValidatorWiring {
  /** host path for fresh clones — must be bind-mountable by the container runtime */
  workRoot: string;
  /** pinned sandbox image (M1b: alpine:3.22) */
  image: string;
}

export function createContractValidator(wiring: ValidatorWiring): ContractValidator {
  return new ContractValidator(
    new GitSourceCloner(wiring.workRoot),
    new DockerCommandRunner({ image: wiring.image }),
    new FsWorkspaceReader(),
  );
}
