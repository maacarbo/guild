/**
 * Composition-root env parsing: cadence variables must refuse 0 (#12) —
 * `GUILD_SWEEP_SECONDS=0` becomes setInterval(fn, 0), a busy-loop hammering
 * the gateway and store. The spy THROWS because process.exit is mocked:
 * control must never fall through to `return n` with a rejected value.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { envNameEnv, hostEnv, intEnv, readEnv } from "./env.js";

function exitSpy() {
  return vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("readEnv (atomic startup validation — M1b standing rule, audit tdd-8)", () => {
  it("reads set variables and applies fallbacks only when unset", () => {
    vi.stubEnv("GUILD_T_SET", "from-env");
    expect(readEnv([
      { name: "GUILD_T_SET", source: "s", fallback: "unused-fallback" },
      { name: "GUILD_T_UNSET_WITH_FALLBACK", source: "s", fallback: "the-fallback" },
    ])).toEqual({ GUILD_T_SET: "from-env", GUILD_T_UNSET_WITH_FALLBACK: "the-fallback" });
  });

  it("omits a missing optional variable without failing", () => {
    expect(readEnv([{ name: "GUILD_T_ABSENT", source: "s", optional: true }])).toEqual({});
  });

  it("lists EVERY missing variable with its owning source in one refusal — never one-error-at-a-time", () => {
    const exit = exitSpy();
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg: string) => void lines.push(String(msg)));
    expect(() =>
      readEnv([
        { name: "GUILD_T_MISSING_A", source: "owner of A" },
        { name: "GUILD_T_PRESENT", source: "s", fallback: "x" },
        { name: "GUILD_T_MISSING_B", source: "owner of B" },
      ]),
    ).toThrow("process.exit called");
    const listing = lines.join("\n");
    expect(listing).toContain("GUILD_T_MISSING_A");
    expect(listing).toContain("owner of A");
    expect(listing).toContain("GUILD_T_MISSING_B");
    expect(listing).toContain("owner of B");
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});

describe("intEnv", () => {
  it("parses a non-negative integer", () => {
    expect(intEnv({ N: "30" }, "N")).toBe(30);
    expect(intEnv({ N: "0" }, "N")).toBe(0);
  });

  it("rejects negatives and non-integers atomically via exit", () => {
    const spy = exitSpy();
    expect(() => intEnv({ N: "-1" }, "N")).toThrow("process.exit called");
    expect(() => intEnv({ N: "lots" }, "N")).toThrow("process.exit called");
    expect(spy).toHaveBeenCalledWith(1);
  });

  it("a min floor rejects values below it — cadence vars must refuse the 0 busy-loop (#12)", () => {
    const spy = exitSpy();
    expect(() => intEnv({ N: "0" }, "N", { min: 1 })).toThrow("process.exit called");
    expect(spy).toHaveBeenCalledWith(1);
    expect(intEnv({ N: "1" }, "N", { min: 1 })).toBe(1);
  });
});

describe("hostEnv (audit clean-1: GUILD_GIT_CRED_HOST must be a host the helper can match literally)", () => {
  it("accepts a bare hostname, optionally with a port, exactly as git sends host=", () => {
    expect(hostEnv({ H: "gitlab.com" }, "H")).toBe("gitlab.com");
    expect(hostEnv({ H: "git.example.com:8443" }, "H")).toBe("git.example.com:8443");
    expect(hostEnv({}, "H")).toBeUndefined();
  });

  it("accepts any casing — DNS names are case-insensitive and the helper matches accordingly", () => {
    expect(hostEnv({ H: "GitHub.com" }, "H")).toBe("GitHub.com");
  });

  it("an explicit empty value means unset — the .env idiom must not brick startup", () => {
    expect(hostEnv({ H: "" }, "H")).toBeUndefined();
  });

  it("refuses values git would never send as host= — schemes, paths, spaces, injection shapes", () => {
    const spy = exitSpy();
    for (const bad of ["https://gitlab.com", "gitlab.com/group", "git lab.com", "host=evil\ninjected", "-lab.com", "lab.com:"]) {
      expect(() => hostEnv({ H: bad }, "H")).toThrow("process.exit called");
    }
    expect(spy).toHaveBeenCalledWith(1);
  });
});

describe("envNameEnv (audit clean-4: GUILD_GIT_CRED_NAME must be a name the daemon helper will expand)", () => {
  it("accepts exactly the helper's allowlist — GUILD_GIT_TOKEN_ plus a non-empty [A-Z0-9_] suffix", () => {
    expect(envNameEnv({ N: "GUILD_GIT_TOKEN_ACME" }, "N")).toBe("GUILD_GIT_TOKEN_ACME");
    expect(envNameEnv({ N: "GUILD_GIT_TOKEN_2ND_REPO" }, "N")).toBe("GUILD_GIT_TOKEN_2ND_REPO");
    expect(envNameEnv({}, "N")).toBeUndefined();
  });

  it("an explicit empty value means unset — `GUILD_GIT_CRED_NAME=` in .env must not brick startup (verify pkg-3)", () => {
    expect(envNameEnv({ N: "" }, "N")).toBeUndefined();
  });

  it("rejects atomically what the helper would silently fall through on — off-shape and non-token names alike", () => {
    const spy = exitSpy();
    for (const bad of [
      "guild_git_token",
      "GUILD-TOKEN",
      "1TOKEN",
      "A B",
      "$(x)",
      // on-shape but outside the allowlisted prefix — the helper will never expand these (verify sh-0)
      "PATH",
      "MULTICA_DAEMON_TOKEN",
      "_PRIVATE",
      "GUILD_GIT_TOKEN_",
    ]) {
      expect(() => envNameEnv({ N: bad }, "N")).toThrow("process.exit called");
    }
    expect(spy).toHaveBeenCalledWith(1);
  });
});
