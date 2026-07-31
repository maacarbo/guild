/**
 * Driven ports of the contract validator (D6). The trust boundary is the
 * point: the cloner runs driver-side with repo-read credentials; the command
 * runner executes checks in a least-trusted sandbox that receives ONLY the
 * clone — no credentials, no network. Adapters: git CLI + `docker run`.
 */

export interface ClonedSource {
  /** absolute path of a fresh clone checked out detached at the requested SHA */
  dir: string;
  cleanup(): Promise<void>;
}

export interface SourceCloner {
  cloneAtSha(repoUrl: string, sha: string): Promise<ClonedSource>;
}

export interface CommandOutcome {
  /** null when the process did not exit on its own (timeout kill) */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandRunner {
  /** run a contract command check from the clone root; must enforce timeoutSeconds */
  runCommand(cloneDir: string, run: string, timeoutSeconds: number, cwd?: string): Promise<CommandOutcome>;
}

export interface WorkspaceReader {
  /** repo-relative read from the clone; null when the file does not exist */
  readFile(cloneDir: string, path: string): Promise<string | null>;
}
