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
  /** clone root: a bind-mountable host path — or, containerized, the mount point of workVolume */
  workRoot: string;
  /** pinned sandbox image (M1b: alpine:3.22; M2b demo floor: node:22-alpine) */
  image: string;
  /** containerized-conductor mode: the named volume backing workRoot (see DockerRunnerConfig) */
  workVolumeName?: string;
}

export function createContractValidator(wiring: ValidatorWiring): ContractValidator {
  return new ContractValidator(
    new GitSourceCloner(wiring.workRoot),
    new DockerCommandRunner({
      image: wiring.image,
      ...(wiring.workVolumeName ? { workVolume: { name: wiring.workVolumeName, workRoot: wiring.workRoot } } : {}),
    }),
    new FsWorkspaceReader(),
  );
}
