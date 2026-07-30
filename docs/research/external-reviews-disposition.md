# External Reviews — Disposition Table

The four 2026-07-30 external reviews ([raw outputs](external-reviews-2026-07-30.md)) all returned REJECT — by design: they reviewed a pre-implementation spec to find exactly these gaps. Every blocker was dispositioned the same day. The follow-up Anthropic-side review ([report](anthropic-review-2026-07-30.md)) went deeper on runtime semantics; its accepted findings were applied in the commits after `36e6978`.

| Reviewer finding | Disposition | Where |
|---|---|---|
| Contract validation execution context undefined (3 reviewers) | **Fixed** — conductor-controlled validation, per-check timeouts, evidence capture, tri-state outcomes; later hardened to an ephemeral least-trusted validator Job with SHA pinning | ARCHITECTURE.md D6; `shared/src/contract.ts`; commit `36e6978`+ |
| Budget attribution mechanism missing (architecture) | **Fixed** — per-engagement virtual keys minted at dispatch, M1 end-to-end proof gate, native `max_budget` as pre-watchdog insurance | ARCHITECTURE.md lifecycle; ROADMAP M1a-0 |
| Auto-approve timer unsafe for a solo operator (requirements) | **Fixed** — explicit approval is the default; timer strictly per-project opt-in | PRODUCT.md flow 2; D6; `GateDecision` |
| Generated-code retrieval undefined (requirements) | **Fixed** — repo-per-project on the operator's GitHub; scratch repo in M1 | ARCHITECTURE.md OQ3 |
| Cancel may not stop token burn (requirements) | **Fixed** — M1a-0 probe: cancel must kill the forked CLI and stop gateway traffic | ROADMAP M1a-0 |
| M1 overpacked; daemon image scope unstated (functional) | **Fixed** — M1 split (M1a-0 / M1a-1 / M1b) with capability-matrix exit criteria; image scoped to Claude Code only | ROADMAP M1 |
| Governance state under-typed; money as floats; no error contract (functional) | **Fixed** — typed governance events, `SubstrateErrorCategory`, integer cents, `EngagementBrief` | `shared/src/governance.ts` et al. |
| M4 hiring has no fallback (functional) | **Fixed** — pre-declared idle-pool fallback | ROADMAP M4; OQ1 |
| No sandbox/NetworkPolicies before M3 (security) | **Partially adopted** — NetworkPolicies + least-privilege + PSA from M1; gVisor per the Talos node-image plan (one labeled worker first) | ARCHITECTURE.md topology; ROADMAP M1a-1 |
| "Replace LiteLLM" / mTLS everywhere / MFA on CLI (security) | **Rejected with rationale** — gateway alternatives were verified weaker; scope-appropriate controls chosen instead (pinning, digest, isolation) | external-reviews file §security; ARCHITECTURE.md D2 |
| RBAC prescription "daemon runs cluster-admin" (security) | **Rejected as factually wrong; better fix applied** — non-privileged SAs were already specified; added `automountServiceAccountToken: false` + PSA `restricted` | ROADMAP M1a-1 |
