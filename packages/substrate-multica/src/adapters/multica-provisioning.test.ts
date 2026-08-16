import { describe, expect, it } from "vitest";
import { markOnboarded } from "./multica-provisioning.js";

// the transport is injected, never a stubbed global (audit tdd-9): the fake
// below is ours to shape, and production callers omit it to get real fetch
function fakeFetch(status: number, body = "{}") {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status });
  }) as typeof fetch;
  return { calls, impl };
}

describe("markOnboarded (#16)", () => {
  it("POSTs the onboarding completion route with the account's bearer token", async () => {
    const { calls, impl } = fakeFetch(200);
    await markOnboarded("http://multica.local:8080", "mul_token_1", impl);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://multica.local:8080/api/me/onboarding/complete");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer mul_token_1");
  });

  it("propagates an API failure — the caller decides whether it is fatal", async () => {
    const { impl } = fakeFetch(500, "nope");
    await expect(markOnboarded("http://multica.local:8080", "t", impl)).rejects.toThrow(/500/);
  });
});
