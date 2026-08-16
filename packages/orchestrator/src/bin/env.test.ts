/**
 * Composition-root env parsing: cadence variables must refuse 0 (#12) —
 * `GUILD_SWEEP_SECONDS=0` becomes setInterval(fn, 0), a busy-loop hammering
 * the gateway and store. The spy THROWS because process.exit is mocked:
 * control must never fall through to `return n` with a rejected value.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { envNameEnv, intEnv } from "./env.js";

function exitSpy() {
  return vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
}

afterEach(() => {
  vi.restoreAllMocks();
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

describe("envNameEnv (audit clean-4: GUILD_GIT_CRED_NAME must be a name the daemon helper will expand)", () => {
  it("accepts exactly the helper's shape — [A-Z_][A-Z0-9_]*", () => {
    expect(envNameEnv({ N: "GUILD_GIT_TOKEN_ACME" }, "N")).toBe("GUILD_GIT_TOKEN_ACME");
    expect(envNameEnv({ N: "_PRIVATE" }, "N")).toBe("_PRIVATE");
    expect(envNameEnv({}, "N")).toBeUndefined();
  });

  it("rejects atomically what the helper would silently fall through on — lowercase, dashes, leading digits", () => {
    const spy = exitSpy();
    for (const bad of ["guild_git_token", "GUILD-TOKEN", "1TOKEN", "A B", "$(x)"]) {
      expect(() => envNameEnv({ N: bad }, "N")).toThrow("process.exit called");
    }
    expect(spy).toHaveBeenCalledWith(1);
  });
});
