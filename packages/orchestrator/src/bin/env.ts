/**
 * Composition-root env plumbing. Startup config validation is atomic (M1b
 * standing rule): every missing variable is listed with its owning normative
 * secret before exit — never one-error-at-a-time.
 */

export interface EnvSpec {
  name: string;
  /** where the value comes from — printed in the failure listing */
  source: string;
  optional?: boolean;
  fallback?: string;
}

export function readEnv(specs: EnvSpec[]): Record<string, string> {
  const values: Record<string, string> = {};
  const missing: EnvSpec[] = [];
  for (const spec of specs) {
    const value = process.env[spec.name] ?? spec.fallback;
    if (value === undefined) {
      if (!spec.optional) missing.push(spec);
      continue;
    }
    values[spec.name] = value;
  }
  if (missing.length > 0) {
    console.error("Missing configuration — set every variable below, then restart:");
    for (const spec of missing) console.error(`  ${spec.name}  (${spec.source})`);
    process.exit(1);
  }
  return values;
}

/**
 * An optional variable whose VALUE must be an env var NAME the daemon's
 * credential helper will actually expand — GUILD_GIT_TOKEN_ plus a non-empty
 * [A-Z0-9_] suffix (mirrors docker/daemon/guild-git-cred.sh, which
 * allowlists that prefix so an agent naming PATH or MULTICA_DAEMON_TOKEN can
 * never exfiltrate it). Anything else would make the helper fall through to
 * the ambient PAT silently, defeating the D17 isolation the operator
 * configured — refuse at startup instead (audit clean-4). An explicit empty
 * value (`NAME=` in .env) means unset.
 */
export function envNameEnv(values: Record<string, string>, name: string): string | undefined {
  const value = values[name];
  if (value === undefined || value === "") return undefined;
  if (!/^GUILD_GIT_TOKEN_[A-Z0-9_]+$/.test(value)) {
    console.error(
      `${name} must name a daemon env var as GUILD_GIT_TOKEN_<SUFFIX> ([A-Z0-9_], non-empty suffix), got "${value}" — ` +
        "the daemon's credential helper only expands that namespace and would silently fall back to the ambient PAT (D17).",
    );
    process.exit(1);
  }
  return value;
}

/**
 * An optional variable whose VALUE must be a request host exactly as git
 * sends it in a credential request's `host=` line (hostname, optional
 * :port) — the daemon's helper compares it literally to scope the named
 * token to one host (D17 host scoping, audit clean-1). A scheme, path, or
 * whitespace would never match a real request, silently disabling the token
 * everywhere — refuse at startup instead. An explicit empty value means
 * unset.
 */
export function hostEnv(values: Record<string, string>, name: string): string | undefined {
  const value = values[name];
  if (value === undefined || value === "") return undefined;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?$/i.test(value)) {
    console.error(
      `${name} must be a bare request host as git sends it (hostname, optional :port), got "${value}" — ` +
        "a scheme, path, or whitespace never matches a credential request's host= line (D17 host scoping).",
    );
    process.exit(1);
  }
  return value;
}

export function intEnv(values: Record<string, string>, name: string, opts?: { min?: number }): number {
  const min = opts?.min ?? 0;
  const n = Number.parseInt(values[name]!, 10);
  if (!Number.isInteger(n) || n < min) {
    console.error(`${name} must be an integer >= ${min}, got "${values[name]}"`);
    process.exit(1);
  }
  return n;
}
