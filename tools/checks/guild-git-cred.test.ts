/**
 * Executable spec for the daemon's D17 credential helper
 * (docker/daemon/guild-git-cred.sh) — the security boundary of the
 * per-project name-indirection scheme. The helper's contract:
 *
 * - `get` with a valid-shape GUILD_GIT_CRED name whose env var holds a value
 *   answers that token; anything else (bad shape, unset name, empty value)
 *   falls through to the ambient credential store.
 * - The name is agent-reachable input: only `[A-Z_][A-Z0-9_]*` is ever
 *   expanded — an injection-shaped name must reach the eval never.
 * - The helper is GET-ONLY (audit clean-0): `store` would copy per-project
 *   tokens into the shared ambient file, `erase` would delete the bootstrap
 *   entry after a 401 — both must succeed as no-ops.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const helper = join(import.meta.dirname, "..", "..", "docker", "daemon", "guild-git-cred.sh");
const AMBIENT_LINE = "https://x-access-token:AMBIENT_PAT@github.com";
const GET_REQUEST = "protocol=https\nhost=github.com\n\n";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "guild-cred-"));
  writeFileSync(join(home, ".git-credentials"), `${AMBIENT_LINE}\n`, { mode: 0o600 });
});

function run(op: string, env: Record<string, string> = {}, input = GET_REQUEST): string {
  return execFileSync("sh", [helper, op], {
    env: { PATH: process.env.PATH!, HOME: home, ...env },
    input,
    encoding: "utf8",
  });
}

function ambientFile(): string {
  return readFileSync(join(home, ".git-credentials"), "utf8");
}

describe("get: name-indirection (#6, D17)", () => {
  it("answers the named env var's token with the default username", () => {
    const out = run("get", { GUILD_GIT_CRED: "GUILD_GIT_TOKEN_ACME", GUILD_GIT_TOKEN_ACME: "proj-tok-1" });
    expect(out).toContain("username=x-access-token");
    expect(out).toContain("password=proj-tok-1");
    expect(out).not.toContain("AMBIENT_PAT");
  });

  it("honors GUILD_GIT_CRED_USERNAME for hosts that need a specific username", () => {
    const out = run("get", {
      GUILD_GIT_CRED: "GUILD_GIT_TOKEN_ACME",
      GUILD_GIT_TOKEN_ACME: "proj-tok-1",
      GUILD_GIT_CRED_USERNAME: "gitlab-ci",
    });
    expect(out).toContain("username=gitlab-ci");
  });

  it("falls through to the ambient store when no name is configured", () => {
    expect(run("get")).toContain("password=AMBIENT_PAT");
  });

  it("falls through when the named var is unset or empty — an unconfigured project keeps working", () => {
    expect(run("get", { GUILD_GIT_CRED: "GUILD_GIT_TOKEN_UNSET" })).toContain("password=AMBIENT_PAT");
    expect(run("get", { GUILD_GIT_CRED: "GUILD_GIT_TOKEN_EMPTY", GUILD_GIT_TOKEN_EMPTY: "" })).toContain(
      "password=AMBIENT_PAT",
    );
  });
});

describe("the name is hostile input — never expanded off-shape", () => {
  it.each([
    ["lowercase", "guild_git_token"],
    ["dashed", "GUILD-TOKEN"],
    ["digit-leading", "1TOKEN"],
    ["command substitution", "$(touch pwned)"],
    ["semicolon injection", "PATH;touch pwned"],
    ["space injection", "A B"],
  ])("%s name falls through to the ambient store untouched", (_label, name) => {
    const out = run("get", { GUILD_GIT_CRED: name, GUILD_GIT_TOKEN_ACME: "proj-tok-1" });
    expect(out).toContain("password=AMBIENT_PAT");
    expect(out).not.toContain("proj-tok-1");
  });
});

describe("get-only (audit clean-0): the ambient store is entrypoint-seeded, never runtime-written", () => {
  it("store succeeds as a no-op — a per-project token never lands in the shared file", () => {
    run("store", { GUILD_GIT_CRED: "GUILD_GIT_TOKEN_ACME", GUILD_GIT_TOKEN_ACME: "proj-tok-1" },
      "protocol=https\nhost=gitlab.com\nusername=x\npassword=proj-tok-1\n\n");
    expect(ambientFile()).toBe(`${AMBIENT_LINE}\n`);
  });

  it("erase succeeds as a no-op — a 401 on a stale token cannot delete the bootstrap entry", () => {
    run("erase", {}, "protocol=https\nhost=github.com\nusername=x-access-token\npassword=AMBIENT_PAT\n\n");
    expect(ambientFile()).toBe(`${AMBIENT_LINE}\n`);
  });
});
