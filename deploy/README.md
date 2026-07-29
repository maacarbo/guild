# deploy/

- **M1:** docker-compose for the full local stack — self-hosted Multica (pinned version), LiteLLM, Guild Postgres.
- **M3:** Kubernetes — upstream Multica Helm chart (control plane only; verified it ships no daemon template) + Guild-contributed daemon Deployment (custom image, `runtimeClassName: gvisor`, scoped NetworkPolicy) + Guild conductor + hardened LiteLLM. Topology in `docs/ARCHITECTURE.md`.
