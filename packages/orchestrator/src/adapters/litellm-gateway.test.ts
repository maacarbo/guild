import { describe, expect, it } from "vitest";
import { LiteLlmModelGateway } from "./litellm-gateway.js";

type Call = { url: string; method: string; body?: unknown };

/** minimal LiteLLM key-API stub capturing requests (shapes verified live 2026-07-31) */
function stubGateway() {
  const calls: Call[] = [];
  const keys = new Map<string, { key: string; alias: string; spend: number; max_budget: number }>();
  let seq = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const respond = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

    if (url.includes("/key/generate")) {
      const alias = body.key_alias as string;
      if ([...keys.values()].some((k) => k.alias === alias)) {
        return respond(400, { error: { message: `Key with alias '${alias}' already exists.` } });
      }
      const key = `sk-stub-${++seq}`;
      keys.set(key, { key, alias, spend: 0, max_budget: body.max_budget });
      return respond(200, { key, key_alias: alias, max_budget: body.max_budget });
    }
    if (url.includes("/key/list")) {
      const alias = new URL(url).searchParams.get("key_alias");
      const rows = [...keys.values()]
        .filter((k) => k.alias === alias)
        .map((k) => ({ token: `hash-${k.key}`, key_alias: k.alias, spend: k.spend, max_budget: k.max_budget }));
      return respond(200, { keys: rows, total_count: rows.length });
    }
    if (url.includes("/key/info")) {
      const key = new URL(url).searchParams.get("key")!;
      const row = keys.get(key);
      if (!row) return respond(404, { error: { message: "not found" } });
      return respond(200, { key, info: { spend: row.spend, max_budget: row.max_budget } });
    }
    if (url.includes("/key/delete")) {
      const targets: string[] = body.keys ?? [];
      const aliases: string[] = body.key_aliases ?? [];
      let deleted = 0;
      for (const [k, row] of keys) {
        if (targets.includes(k) || targets.includes(`hash-${k}`) || aliases.includes(row.alias)) {
          keys.delete(k);
          deleted++;
        }
      }
      if (!deleted) return respond(404, { error: { message: "No keys found" } });
      return respond(200, { deleted_keys: targets });
    }
    return respond(500, { error: { message: `unstubbed ${url}` } });
  };
  return { fetchImpl, calls, keys };
}

const make = () => {
  const stub = stubGateway();
  const gateway = new LiteLlmModelGateway(
    { baseUrl: "http://litellm.test", masterKey: "sk-master" },
    stub.fetchImpl,
  );
  return { ...stub, gateway };
};

describe("LiteLlmModelGateway.mintKey", () => {
  it("converts integer cents to the dollar-float max_budget — 250 cents mints 2.5, never 250", async () => {
    const { gateway, calls } = make();
    const minted = await gateway.mintKey("eng-1", 250);
    const gen = calls.find((c) => c.url.includes("/key/generate"))!;
    expect((gen.body as { max_budget: number }).max_budget).toBe(2.5);
    expect(minted).toEqual({ engagementId: "eng-1", key: "sk-stub-1", budgetCents: 250 });
  });

  it("names the alias after the engagement", async () => {
    const { gateway, calls } = make();
    await gateway.mintKey("eng-42", 100);
    const gen = calls.find((c) => c.url.includes("/key/generate"))!;
    expect((gen.body as { key_alias: string }).key_alias).toBe("guild-eng-eng-42");
  });

  it("is idempotent within the process: second mint returns the same key without a second generate", async () => {
    const { gateway, calls } = make();
    const first = await gateway.mintKey("eng-1", 100);
    const second = await gateway.mintKey("eng-1", 100);
    expect(second).toEqual(first);
    expect(calls.filter((c) => c.url.includes("/key/generate"))).toHaveLength(1);
  });

  it("rotates a stale alias from a previous process: deletes it and mints fresh (exactly one live key)", async () => {
    const { gateway, keys } = make();
    keys.set("sk-stale", { key: "sk-stale", alias: "guild-eng-eng-1", spend: 0.1, max_budget: 1 });
    const minted = await gateway.mintKey("eng-1", 100);
    expect(minted.key).not.toBe("sk-stale");
    expect(keys.has("sk-stale")).toBe(false);
  });
});

describe("LiteLlmModelGateway.getSpend", () => {
  it("rounds spend UP to integer cents and reports exhaustion at the cap", async () => {
    const { gateway, keys } = make();
    const { key } = await gateway.mintKey("eng-1", 100);
    keys.get(key)!.spend = 0.0193; // the M1a P10 observed overshoot value
    const spend = await gateway.getSpend("eng-1");
    expect(spend).toEqual({ engagementId: "eng-1", spentCents: 2, budgetCents: 100, exhausted: false });
    keys.get(key)!.spend = 1.01;
    expect((await gateway.getSpend("eng-1")).exhausted).toBe(true);
  });

  it("does not overstate cents on IEEE754 drift: 0.07 is 7 cents, 0.14 is 14, never +1", async () => {
    const { gateway, keys } = make();
    const { key } = await gateway.mintKey("eng-1", 100);
    keys.get(key)!.spend = 0.07;
    expect((await gateway.getSpend("eng-1")).spentCents).toBe(7);
    keys.get(key)!.spend = 0.14;
    expect((await gateway.getSpend("eng-1")).spentCents).toBe(14);
  });

  it("reads spend by alias when this process never minted the key (conductor restart)", async () => {
    const { gateway, keys } = make();
    keys.set("sk-prior", { key: "sk-prior", alias: "guild-eng-eng-7", spend: 0.25, max_budget: 0.5 });
    const spend = await gateway.getSpend("eng-7");
    expect(spend).toEqual({ engagementId: "eng-7", spentCents: 25, budgetCents: 50, exhausted: false });
  });

  it("throws for an engagement with no key anywhere", async () => {
    const { gateway } = make();
    await expect(gateway.getSpend("eng-ghost")).rejects.toThrow(/eng-ghost/);
  });
});

describe("LiteLlmModelGateway.revokeKey", () => {
  it("deletes the key and tolerates an already-deleted key (idempotent retries)", async () => {
    const { gateway, keys } = make();
    const { key } = await gateway.mintKey("eng-1", 100);
    await gateway.revokeKey("eng-1");
    expect(keys.has(key)).toBe(false);
    await gateway.revokeKey("eng-1");
    await gateway.revokeKey("eng-1");
  });

  it("revokes by alias when this process never held the secret", async () => {
    const { gateway, keys } = make();
    keys.set("sk-orphan", { key: "sk-orphan", alias: "guild-eng-eng-9", spend: 0, max_budget: 1 });
    await gateway.revokeKey("eng-9");
    expect(keys.has("sk-orphan")).toBe(false);
  });
});
