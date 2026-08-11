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

export function intEnv(values: Record<string, string>, name: string, opts?: { min?: number }): number {
  const min = opts?.min ?? 0;
  const n = Number.parseInt(values[name]!, 10);
  if (!Number.isInteger(n) || n < min) {
    console.error(`${name} must be an integer >= ${min}, got "${values[name]}"`);
    process.exit(1);
  }
  return n;
}
