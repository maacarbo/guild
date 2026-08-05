/**
 * CommandRunner over `docker run` — the Tier 1 least-trusted sandbox (D6):
 * the container sees only the clone bind-mount; no credentials, no network
 * (--network none), no Linux capabilities (--cap-drop ALL) and no privilege
 * escalation (no-new-privileges), non-root in containerized mode, capped
 * cpu/memory/pids (deploy/README Tier 1 floor). Every container is named so that
 * a client-side timeout can `docker rm -f` it — killing the `docker run`
 * client alone leaves the container running (verified live 2026-07-31).
 * Evidence overflow (> maxBuffer) resolves as a deterministic non-matching
 * exit, never a retryable validator error — retries could not converge.
 *
 * M2 note: when the conductor itself is containerized, this driver talks to a
 * scoped docker-socket proxy, never a raw socket mount (ROADMAP Tier 1 rule).
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import type { CommandOutcome, CommandRunner } from "../ports/validator.js";

export interface DockerRunnerConfig {
  /** sandbox image; pinned by the caller (M1b: alpine:3.22, locally present) */
  image: string;
  /**
   * Containerized-conductor mode (M2b compose service): the validator work
   * root is this NAMED volume, mounted at workRoot inside the conductor.
   * Mount the volume by name and locate the clone by its path relative to
   * workRoot — a bind path would resolve against the docker daemon's host
   * filesystem, not this container's.
   */
  workVolume?: { name: string; workRoot: string };
}

/** pure argument assembly — the sandbox invariants, unit-testable */
export function buildRunArgs(
  config: DockerRunnerConfig,
  cloneDir: string,
  run: string,
  containerName: string,
  cwd?: string,
): string[] {
  let mount = `${cloneDir}:/work`;
  let base = "/work";
  if (config.workVolume) {
    const rel = relative(config.workVolume.workRoot, cloneDir);
    if (rel.startsWith("..") || rel.startsWith("/")) {
      throw new Error(`clone dir ${cloneDir} is outside the validator work root ${config.workVolume.workRoot}`);
    }
    mount = `${config.workVolume.name}:/work`;
    base = `/work/${rel}`;
  }
  return [
    "run",
    "--rm",
    "--name",
    containerName,
    // Sandbox invariants (deploy/README Tier 1 floor): no network, no Linux
    // capabilities, no privilege escalation, capped cpu/memory/pids. The check
    // command is hostile agent-authored input — `--network none` is not the
    // only containment (A4). `--cap-drop ALL` means even container-root holds no
    // capability; `no-new-privileges` blocks regaining any.
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--cpus",
    "1",
    "--memory",
    "512m",
    "--pids-limit",
    "256",
    "--init",
    // Containerized mode: the conductor's `node` user (uid 1000, per
    // docker/conductor/Dockerfile) creates the clone on the shared named volume,
    // so the sandbox runs non-root as that same uid — it can read/write its own
    // clone yet carries no host-root identity. Host mode's clone owner is the
    // host conductor's uid (unknown here), so a fixed uid is not forced there.
    ...(config.workVolume ? ["--user", "1000:1000"] : []),
    "-v",
    mount,
    "-w",
    cwd ? `${base}/${cwd}` : base,
    config.image,
    "sh",
    "-c",
    run,
  ];
}

const EVIDENCE_BUFFER = 4 * 1024 * 1024;

export class DockerCommandRunner implements CommandRunner {
  constructor(private readonly config: DockerRunnerConfig) {}

  runCommand(cloneDir: string, run: string, timeoutSeconds: number, cwd?: string): Promise<CommandOutcome> {
    const name = `guild-validate-${randomUUID().slice(0, 8)}`;
    const args = buildRunArgs(this.config, cloneDir, run, name, cwd);
    return new Promise((resolve, reject) => {
      execFile(
        "docker",
        args,
        { timeout: timeoutSeconds * 1000, killSignal: "SIGKILL", maxBuffer: EVIDENCE_BUFFER },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ exitCode: 0, stdout, stderr, timedOut: false });
            return;
          }
          const e = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
          // reap the container before resolving — the client dying does not stop it
          const reapThen = (outcome: CommandOutcome) =>
            execFile("docker", ["rm", "-f", name], () => resolve(outcome));
          if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            reapThen({
              exitCode: null,
              stdout,
              stderr: `${stderr}\n[check output exceeded the ${EVIDENCE_BUFFER / (1024 * 1024)}MB evidence limit]`,
              timedOut: false,
            });
            return;
          }
          if (e.killed) {
            reapThen({ exitCode: null, stdout, stderr, timedOut: true });
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
