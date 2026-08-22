import { describe, expect, it } from "vitest";
import { ensureAgent, markOnboarded } from "./multica-provisioning.js";

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

describe("ensureAgent runtime selection (#70)", () => {
  it("creates on the NEWEST online Opencode row — the dead daemon's row lingers 'online' through its grace window", async () => {
    const posts: { url: string; body: unknown }[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/runtimes")) {
        return Response.json([
          { id: "rt-corpse", name: "Opencode (guild-daemon-1)", status: "online", last_seen_at: "2026-08-22T10:00:00Z" },
          { id: "rt-live", name: "Opencode (guild-daemon-1)", status: "online", last_seen_at: "2026-08-22T10:05:00Z" },
        ]);
      }
      if (u.endsWith("/api/agents") && init?.method === "POST") {
        posts.push({ url: u, body: JSON.parse(String(init.body)) });
        return Response.json({ id: "a-new" }, { status: 201 });
      }
      if (u.endsWith("/api/agents")) return Response.json([]);
      throw new Error(`unexpected call: ${init?.method ?? "GET"} ${u}`);
    }) as typeof fetch;

    await ensureAgent("http://multica.test", "tok", "ws-1", { name: "guild-x", model: "m" }, impl);
    expect(posts).toHaveLength(1);
    expect((posts[0]!.body as { runtime_id: string }).runtime_id).toBe("rt-live");
  });
});

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
