# deploy/

- **M1–M2 (dev mode):** direct `kubectl`/`helm` into dedicated dev namespaces on the home cluster — pinned upstream Multica chart (ships no daemon template), chart's own Postgres, a Guild-scoped LiteLLM instance, port-forward exposure. Dev namespaces are outside Flux's purview; **never ad-hoc-edit Flux-managed resources** (e.g. the shared `litellm` namespace) — reconciliation reverts them. docker-compose kept only as an offline fallback.
- **M3 (promotion):** Guild conductor joins the cluster; daemon hardening (`runtimeClassName: gvisor`, scoped NetworkPolicy); LiteLLM hardened per D2; then the proven stack is committed to `home-lab/k8s-cluster` as Flux-managed resources and ad-hoc dev resources are removed. Topology in `docs/ARCHITECTURE.md`.
