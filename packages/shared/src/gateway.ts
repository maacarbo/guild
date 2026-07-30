/**
 * ModelGateway — driven port for the model-traffic gateway (D2, D9).
 *
 * The gateway is the budget enforcement point: every agent CLI authenticates
 * with a per-engagement virtual key minted here, never a provider key. The
 * first adapter is LiteLLM (`/key/generate`, `/key/info`, `/key/delete`);
 * swapping gateways is an adapter change only.
 *
 * Amounts are integer cents (published-language convention, see stages.ts).
 * M1a evidence (capability-matrix-m1a.md): caps are insurance, not precision —
 * spend writes batch upstream (~60s), so expect at least one in-flight turn of
 * overshoot past `budgetCents`; and the gateway, not the substrate, is the
 * spend source of truth (substrate usage is zero for failed runs).
 */

export interface EngagementKey {
  /** Engagement this key meters; one key per engagement (D2). */
  engagementId: string;
  /** Opaque bearer credential the agent CLI authenticates with. */
  key: string;
  /** Hard cap the gateway enforces (429 on exhaustion), integer cents. */
  budgetCents: number;
}

export interface KeySpend {
  engagementId: string;
  /** Spend recorded by the gateway so far, integer cents (rounded up). */
  spentCents: number;
  budgetCents: number;
  /** True once the gateway rejects traffic for this key. */
  exhausted: boolean;
}

export interface ModelGateway {
  /**
   * Mint the engagement's virtual key with a hard budget cap. Idempotent per
   * engagementId: re-minting for the same engagement returns the existing key.
   */
  mintKey(engagementId: string, budgetCents: number): Promise<EngagementKey>;

  /**
   * Revoke the key so all further traffic is rejected. Termination protocol:
   * revocation accompanies terminal engagement states and MUST be followed by
   * cancelling the substrate work item — capped agents linger in retry
   * backoff, they do not stop themselves (M1a P10).
   */
  revokeKey(engagementId: string): Promise<void>;

  /** Read spend for reconciliation and the budget ledger. */
  getSpend(engagementId: string): Promise<KeySpend>;
}
