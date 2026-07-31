/**
 * CommandRunner over `docker run` — the Tier 1 least-trusted sandbox (D6):
 * the container sees only the clone bind-mount; no credentials, no network
 * (--network none), capped cpu/memory/pids. Timeout enforcement kills the
 * container via the CLI timeout (init reaps the sh).
 *
 * M2 note: when the conductor itself is containerized, this driver talks to a
 * scoped docker-socket proxy, never a raw socket mount (ROADMAP Tier 1 rule).
 */

import { execFile } from "node:child_process";
import type { CommandOutcome, CommandRunner } from "../ports/validator.js";

export interface DockerRunnerConfig {
  /** sandbox image; pinned by the caller (M1b: alpine:3.22, locally present) */
  image: string;
}

export class DockerCommandRunner implements CommandRunner {
  constructor(private readonly config: DockerRunnerConfig) {}

  runCommand(cloneDir: string, run: string, timeoutSeconds: number, cwd?: string): Promise<CommandOutcome> {
    const workdir = cwd ? `/work/${cwd}` : "/work";
    const args = [
      "run",
      "--rm",
      "--network",
      "none",
      "--cpus",
      "1",
      "--memory",
      "512m",
      "--pids-limit",
      "256",
      "--init",
      "-v",
      `${cloneDir}:/work`,
      "-w",
      workdir,
      this.config.image,
      "sh",
      "-c",
      run,
    ];
    return new Promise((resolve, reject) => {
      execFile(
        "docker",
        args,
        { timeout: timeoutSeconds * 1000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ exitCode: 0, stdout, stderr, timedOut: false });
            return;
          }
          const e = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
          if (e.killed) {
            resolve({ exitCode: null, stdout, stderr, timedOut: true });
            return;
          }
          if (typeof e.code === "number") {
            // the check's own exit code — a normal outcome, not an infra fault
            resolve({ exitCode: e.code, stdout, stderr, timedOut: false });
            return;
          }
          // spawn-level failure (docker missing, daemon down) → validator error
          reject(error);
        },
      );
    });
  }
}
