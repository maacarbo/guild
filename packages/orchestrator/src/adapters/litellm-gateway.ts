/**
 * ModelGateway over LiteLLM's key API (D2/D9; endpoint shapes verified live
 * against v1.94.0, 2026-07-31: /key/generate {max_budget: DOLLAR FLOAT,
 * key_alias}, /key/list?key_alias=&return_full_object=true → rows with token
 * hash, /key/info?key=, /key/delete {keys|key_aliases} → 404 when nothing
 * matched).
 *
 * Money rule (ARCHITECTURE.md budget para): the port speaks integer cents;
 * this adapter passes `budgetCents / 100` — raw cents would mint a cap 100x
 * too large.
 *
 * Key custody is process-local until the conductor's Postgres exists (M2):
 * within a process, mintKey is idempotent per engagement; a re-mint from a
 * NEW process finds the stale alias, revokes it, and mints fresh — exactly
 * one live key per engagement either way, which is the invariant that
 * matters (the budget cap travels with the live key).
 */

import type { EngagementKey, KeySpend, ModelGateway } from "@guild/shared";

export interface LiteLlmGatewayConfig {
  baseUrl: string;
  masterKey: string;
}

const aliasFor = (engagementId: string) => `guild-eng-${engagementId}`;

export class LiteLlmModelGateway implements ModelGateway {
  private readonly minted = new Map<string, EngagementKey>();

  constructor(
    private readonly config: LiteLlmGatewayConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    return this.fetchImpl(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.config.masterKey}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  private async listByAlias(alias: string): Promise<Array<{ token: string }>> {
    const res = await this.request(
      "GET",
      `/key/list?key_alias=${encodeURIComponent(alias)}&return_full_object=true`,
    );
    if (!res.ok) throw new Error(`gateway key list → ${res.status}`);
    const data = (await res.json()) as { keys?: Array<{ token: string }> };
    return data.keys ?? [];
  }

  async mintKey(engagementId: string, budgetCents: number): Promise<EngagementKey> {
    const existing = this.minted.get(engagementId);
    if (existing) return existing;

    const alias = aliasFor(engagementId);
    const stale = await this.listByAlias(alias);
    if (stale.length > 0) {
      const res = await this.request("POST", "/key/delete", { keys: stale.map((k) => k.token) });
      if (!res.ok && res.status !== 404) {
        throw new Error(`gateway stale-key rotation for ${engagementId} → ${res.status}`);
      }
    }

    const res = await this.request("POST", "/key/generate", {
      key_alias: alias,
      max_budget: budgetCents / 100,
      metadata: { guild_engagement_id: engagementId },
    });
    if (!res.ok) {
      throw new Error(`gateway key mint for ${engagementId} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const { key } = (await res.json()) as { key: string };
    const minted: EngagementKey = { engagementId, key, budgetCents };
    this.minted.set(engagementId, minted);
    return minted;
  }

  async getSpend(engagementId: string): Promise<KeySpend> {
    const minted = this.minted.get(engagementId);
    if (!minted) {
      throw new Error(`no key minted for engagement ${engagementId} in this process`);
    }
    const res = await this.request("GET", `/key/info?key=${encodeURIComponent(minted.key)}`);
    if (!res.ok) throw new Error(`gateway spend read for ${engagementId} → ${res.status}`);
    const data = (await res.json()) as { info: { spend: number; max_budget: number | null } };
    const spentCents = Math.ceil(data.info.spend * 100);
    return {
      engagementId,
      spentCents,
      budgetCents: minted.budgetCents,
      exhausted: data.info.max_budget !== null && data.info.spend >= data.info.max_budget,
    };
  }

  async revokeKey(engagementId: string): Promise<void> {
    const minted = this.minted.get(engagementId);
    const body = minted ? { keys: [minted.key] } : { key_aliases: [aliasFor(engagementId)] };
    const res = await this.request("POST", "/key/delete", body);
    // 404 = nothing left to revoke — idempotent retries and cross-process revokes are safe
    if (!res.ok && res.status !== 404) {
      throw new Error(`gateway key revoke for ${engagementId} → ${res.status}`);
    }
    this.minted.delete(engagementId);
  }
}
