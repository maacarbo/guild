# deploy/

- **M1:** Multica control plane on the home cluster via **Flux GitOps** — `HelmRelease` over the pinned upstream chart (which ships no daemon template), committed to the separate `home-lab/k8s-cluster` repo (that cluster's hard rule: no ad-hoc `helm install`/`kubectl apply`). Gateway: the cluster's **existing** LiteLLM instance (ns `litellm`) extended with an Anthropic route + Guild-scoped key. Guild-built daemon container tested against the live backend. docker-compose kept only as an offline fallback.
- **M3:** Guild conductor Deployment joins the cluster; daemon hardening (`runtimeClassName: gvisor`, scoped NetworkPolicy); LiteLLM hardened per D2. Topology in `docs/ARCHITECTURE.md`.
