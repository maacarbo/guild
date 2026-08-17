import { afterEach, describe, expect, it, vi } from "vitest";
import type { MulticaIssue } from "../domain/multica-types.js";
import { MulticaHttpError } from "../ports/multica-api.js";
import { FetchMulticaApi } from "./fetch-multica-api.js";

const issue = (id: string): MulticaIssue => ({
  id,
  title: `t-${id}`,
  description: "",
  status: "todo",
  assignee_id: null,
  updated_at: "2026-07-31T12:00:00Z",
});

const api = () => new FetchMulticaApi({ baseUrl: "http://multica.test", token: "mul_x", workspaceId: "ws" });

function stubIssuesEndpoint(pages: () => { issues: MulticaIssue[]; total: number }) {
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("/api/issues")) throw new Error(`unstubbed ${url}`);
    return new Response(JSON.stringify(pages()), { status: 200 });
  }) as typeof fetch);
}

afterEach(() => vi.unstubAllGlobals());

describe("FetchMulticaApi.listIssues pagination", () => {
  it("collects across pages, deduping by id", async () => {
    const all = Array.from({ length: 150 }, (_, i) => issue(String(i)));
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      return new Response(
        JSON.stringify({ issues: all.slice(offset, offset + 100), total: all.length }),
        { status: 200 },
      );
    }) as typeof fetch);
    const listed = await api().listIssues();
    expect(listed).toHaveLength(150);
    expect(new Set(listed.map((i) => i.id)).size).toBe(150);
  });

  it("does not silently drop an item when a row is deleted mid-pagination (drift regression)", async () => {
    // 150 issues; issue "0" is deleted after page 1 is served — offset 100 now
    // starts one row earlier. The first-page total (150) keeps us fetching and
    // the dedupe absorbs the overlap: every surviving issue must be present.
    const all = Array.from({ length: 150 }, (_, i) => issue(String(i)));
    let served = 0;
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      if (served++ === 1) all.shift(); // deletion lands between page 1 and 2
      return new Response(
        JSON.stringify({ issues: all.slice(offset, offset + 100), total: all.length }),
        { status: 200 },
      );
    }) as typeof fetch);
    const listed = await api().listIssues();
    const ids = new Set(listed.map((i) => i.id));
    for (const survivor of all) expect(ids.has(survivor.id), `issue ${survivor.id} present`).toBe(true);
  });

  it("returns a short list cleanly when the total is accurate", async () => {
    stubIssuesEndpoint(() => ({ issues: [issue("a")], total: 1 }));
    expect(await api().listIssues()).toHaveLength(1);
  });

  it("fails loud (retryable) instead of returning a silently incomplete list under sustained churn", async () => {
    // every sweep claims 99 rows exist but pages run dry — never self-consistent
    let calls = 0;
    stubIssuesEndpoint(() => (calls++ % 2 === 0 ? { issues: [issue("a")], total: 99 } : { issues: [], total: 99 }));
    await expect(api().listIssues()).rejects.toThrow(/did not stabilize/);
  });
});

describe("FetchMulticaApi error surface", () => {
  it("throws MulticaHttpError carrying the HTTP status on non-2xx", async () => {
    vi.stubGlobal("fetch", (async () => new Response("nope", { status: 404 })) as typeof fetch);
    const err = await api()
      .getIssue("ghost")
      .catch((e) => e);
    expect(err).toBeInstanceOf(MulticaHttpError);
    expect(err.httpStatus).toBe(404);
  });

  it("always sends allow_duplicate on issue create (Guild titles need not be unique)", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", (async (_: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(issue("new")), { status: 200 });
    }) as typeof fetch);
    await api().createIssue({ title: "t", description: "d" });
    expect(body.allow_duplicate).toBe(true);
  });
});

describe("agent-management primitives (M3 hiring — live-probed 2026-08-11)", () => {
  it("listRuntimes GETs /api/runtimes", async () => {
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("http://multica.test/api/runtimes");
      return new Response(JSON.stringify([{ id: "rt-1", status: "online" }]), { status: 200 });
    }) as typeof fetch);
    expect(await api().listRuntimes()).toEqual([{ id: "rt-1", status: "online" }]);
  });

  it("createAgent authenticates as the runtime OWNER when a lifecycle token is configured — v0.4.26 (MUL-6126) makes private-runtime agent creation owner-only", async () => {
    let auth = "";
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      auth = (init?.headers as Record<string, string>).authorization;
      return new Response(JSON.stringify({ id: "a-9" }), { status: 201 });
    }) as typeof fetch);
    const owner = new FetchMulticaApi({
      baseUrl: "http://multica.test",
      token: "mul_conductor",
      workspaceId: "ws",
      agentLifecycleToken: "mul_daemon",
    });
    await owner.createAgent({ name: "guild-sec-1", runtime_id: "rt-1", model: "litellm/or-deepseek-v4-flash" });
    expect(auth).toBe("Bearer mul_daemon");
  });

  it("env updates and archive keep the MAIN token — both remain admin-allowed on v0.4.26 (probed live 2026-08-17)", async () => {
    const auths: string[] = [];
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      auths.push((init?.headers as Record<string, string>).authorization);
      return new Response(JSON.stringify({ id: "a-9" }), { status: 200 });
    }) as typeof fetch);
    const owner = new FetchMulticaApi({
      baseUrl: "http://multica.test",
      token: "mul_conductor",
      workspaceId: "ws",
      agentLifecycleToken: "mul_daemon",
    });
    await owner.updateAgentEnv("a-9", { K: "v" });
    await owner.archiveAgent("a-9");
    expect(auths).toEqual(["Bearer mul_conductor", "Bearer mul_conductor"]);
  });

  it("createAgent POSTs the spec — runtime_id is REQUIRED by the backend, so the type demands it", async () => {
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://multica.test/api/agents");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ name: "guild-sec-1", runtime_id: "rt-1", model: "litellm/or-deepseek-v3-2" });
      return new Response(JSON.stringify({ id: "a-9", ...body }), { status: 201 });
    }) as typeof fetch);
    const created = await api().createAgent({ name: "guild-sec-1", runtime_id: "rt-1", model: "litellm/or-deepseek-v3-2" });
    expect(created.id).toBe("a-9");
  });

  it("archiveAgent POSTs /api/agents/{id}/archive — the only retire the API has (DELETE is 405)", async () => {
    let called = "";
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      called = `${init?.method} ${String(input)}`;
      return new Response(JSON.stringify({ id: "a-9", archived_at: "t" }), { status: 200 });
    }) as typeof fetch);
    await api().archiveAgent("a-9");
    expect(called).toBe("POST http://multica.test/api/agents/a-9/archive");
  });
});
