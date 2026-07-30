# Agent & model strategy — decisions and evidence (2026-07-30)

Frozen research note (never edited after the fact; corrections land as dated
addenda). Verified by a 4-agent workflow (3 research lenses + evidence-checking
judge) against live sources on 2026-07-30, following the operator's five
questions after the M1a capability proof. Operator's standing constraint,
recorded the same day: **"Don't transgress any policy or rules. We want to
keep this app clean and legal."** Policy compliance is a gate, never a
trade-off.

## Rulings (operator, 2026-07-30)

1. **Anthropic Max subscription: REJECTED for Guild automation.** Technically
   feasible headless (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`,
   1-year token), but fails the policy gate — see evidence below. The Max plan
   stays for the operator's own interactive Claude Code use only. Guild agents
   bill exclusively via API keys through the gateway.
2. **OpenCode is the default agent CLI**, bundled in the daemon container
   (same single image; Multica registers one runtime row per detected CLI).
   Claude Code remains supported and proven (M1a P3) for roles that want it.
3. **LiteLLM is the de-facto model proxy.** All agent model traffic flows
   through it with per-engagement virtual keys (`max_budget` = the budget
   kill-switch, D2). Adding a model = one `model_list` entry.
4. **Simplicity default: OpenCode + LiteLLM.** Any-model coverage comes from
   the gateway's routes (Anthropic direct, OpenRouter for everything else),
   not from multiplying CLIs.
5. **Hexagonal boundary**: the gateway is an adapter behind a `ModelGateway`
   port (`packages/shared/src/gateway.ts`); agent-runtime selection (which
   CLI + model per role) is domain policy carried in the `EngagementPlan`,
   mapped to substrate agent config by the substrate adapter. Swapping
   LiteLLM, adding a CLI, or changing providers must never touch domain code.
   Recorded as ARCHITECTURE.md D9.

## Evidence — Max subscription policy gate (all quotes verified verbatim)

- Anthropic Consumer Terms §3: automated access is banned "**except when you
  are accessing our Services via an Anthropic API Key** or where we otherwise
  explicitly permit it". §2 bans sharing account credentials.
  (anthropic.com/legal/consumer-terms, fetched 2026-07-30)
- Claude Code legal page: OAuth credentials are "designed to support ordinary
  use"; "Anthropic **does not permit third-party developers** to offer
  Claude.ai login or to **route requests through Free, Pro, or Max plan
  credentials** on behalf of their users"; products/services "should use API
  key authentication"; enforcement "without prior notice".
  (code.claude.com/docs/en/legal-and-compliance, fetched 2026-07-30)
- Enforcement precedent: Feb 2026, OpenCode itself removed Claude Pro/Max
  account-key support citing "anthropic legal requests"; Anthropic spokesperson:
  "Third-party harnesses using Claude subscriptions create problems for users
  and are prohibited by our Terms of Service." (The Register, 2026-02-20)
- Guild is an autonomous multi-agent harness — squarely the prohibited
  pattern. Verdict requires no interpretation.

## Evidence — OpenCode candidacy (verified 2026-07-30)

- Home: github.com/anomalyco/opencode (ex `sst/opencode`, org rebranded 2026;
  old URL 301-redirects). MIT. npm `opencode-ai`, latest `1.18.10`
  (published 2026-07-30) — pinnable exactly like Claude Code in the image.
- Provider-agnostic: custom providers via `@ai-sdk/openai-compatible` with
  `baseURL` + `apiKey: "{env:VAR}"` in `opencode.json`; native OpenRouter
  support; per-provider `options.baseURL` overrides. (opencode.ai/docs/providers)
- Model IDs are `provider/model`-qualified (`--model` takes `provider/model`),
  so Multica agents using OpenCode set e.g. `litellm/or-claude-haiku-4-5`
  against the baked `litellm` custom provider.
- Multica launch (source, v0.4.15 `server/pkg/agent/opencode.go`):
  `opencode run --format json --dangerously-skip-permissions [--model …]`,
  full env passthrough (same `buildEnv` as claude), MCP injected via
  `OPENCODE_CONFIG_CONTENT` (scoped to MCP only).
- Caveat: headless contract is rougher than Claude Code's — hence the e2e
  proof probe (capability matrix addendum P16) gates the default flip.

## Evidence — LiteLLM as model selector / OpenRouter (M1a, live)

- Chain source-verified end to end: Multica `agent.model` → daemon claim →
  CLI `--model` flag → LiteLLM `model_list` name → provider route.
- OpenRouter carried the entire M1a probe run (`OPENROUTER_API_KEY` behind
  the gateway): task completed, $0.116 metered to the virtual key, prompt
  caching intact (288k cache-read tokens). See capability-matrix-m1a.md.
- Multi-CLI in one daemon container: no blockers — Multica probes each
  provider independently (`MULTICA_<PROVIDER>_PATH`) and registers one
  runtime row per CLI per daemon.
