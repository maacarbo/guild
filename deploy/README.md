# deploy/

- **M1:** Multica control plane (upstream Helm chart, pinned — verified it ships no daemon template) + LiteLLM on the home cluster, which serves as dev/staging from day one; Guild-built daemon container tested against it. docker-compose kept only as an offline fallback.
- **M3:** Guild conductor Deployment joins the cluster; daemon hardening (`runtimeClassName: gvisor`, scoped NetworkPolicy); LiteLLM hardened per D2. Topology in `docs/ARCHITECTURE.md`.
