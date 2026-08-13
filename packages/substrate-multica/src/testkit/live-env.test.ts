import { afterEach, describe, expect, it, vi } from "vitest";
import { markOnboarded } from "./live-env.js";

describe("markOnboarded (#16)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the onboarding completion route with the account's bearer token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    });
    await markOnboarded("http://multica.local:8080", "mul_token_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://multica.local:8080/api/me/onboarding/complete");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer mul_token_1");
  });

  it("propagates an API failure — the caller decides whether it is fatal", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    await expect(markOnboarded("http://multica.local:8080", "t")).rejects.toThrow(/500/);
  });
});
