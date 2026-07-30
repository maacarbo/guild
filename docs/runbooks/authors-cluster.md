# Author's cluster — personal deployment runbook (non-normative)

*Extracted 2026-07-30 from the product docs per the operator reorganisation directive: Kubernetes is the optional last milestone and strictly generic; everything Talos/Cilium/NFS/Flux/ESO/homelab-specific below is the author's personal worked example. This file is **not** a product deliverable, is linked from nowhere in ROADMAP/PRODUCT (one non-normative footnote in `deploy/README.md` only), and should eventually move to the author's `home-lab` repository. Tier 2 docs may cite this as an external example but must never depend on it. Caution recorded in this runbook's favor: it is the only worked proof of the Tier 2 hardening recommendations.*

## What this was (formerly deploy/README.md "Tier 3 — Hardened reference")

> One concrete instance of Tier 2 with every recommendation turned on, so the hardening advice has a proven implementation: Flux GitOps (M3 promotion), Cilium `toFQDNs` egress + mandatory DNS-proxy rule (CIDR allowlists rejected as unmaintainable), gVisor via Talos system extension on labeled workers, ESO→Bitwarden secrets rendering the same normative Secret names, NFS-backed PVCs with the storage ground rules below.

## Cilium FQDN egress (author implementation of the generic FQDN-egress requirement)

From the former ROADMAP M3 and ARCHITECTURE topology (removed 2026-07-30):

> deny-by-default **CiliumNetworkPolicy with `toFQDNs`** + the mandatory DNS-proxy rule (**probe: L7 DNS policy actually active**)

> Egress control is a **CiliumNetworkPolicy with `toFQDNs`** for git hosts (their IP ranges churn — a CIDR allowlist is forbidden as unmaintainable) plus the **mandatory DNS-proxy rule** `toFQDNs` requires.

## gVisor on Talos (author implementation of the generic runtime-sandboxing requirement)

Verbatim from ARCHITECTURE.md (removed 2026-07-30):

> **gVisor on Talos is a node-image project, not a toggle** (Anthropic review 2026-07-30): it requires a Talos system extension in the machine schematic and a node upgrade/reboot. Plan: extend the schematic on **one labeled worker**, install the RuntimeClass, pin sandboxed workloads there via nodeSelector, smoke-test, and benchmark I/O on representative builds; "mandatory" means extending the schematic cluster-wide via the promotion runbook — it is not a Flux-deliverable.

> gVisor per the Talos reality (schematic extension on one labeled worker + RuntimeClass + nodeSelector + smoke test), cluster-wide via the promotion runbook

## NFS storage specifics (author implementation of the generic storage ground rules)

Verbatim from deploy/README.md (removed 2026-07-30):

> Reference-environment specifics (Tier 3, NFS): sync export + hard mounts for database PVCs or use node-local storage for dev databases; size PVCs up front — the reference storage class has volume expansion disabled.

## GitOps promotion (former ROADMAP M3 final stage — personal-only; no product milestone remains)

Verbatim from the former ROADMAP M3 (removed 2026-07-30):

> **GitOps promotion — the last stage for infrastructure**: commit the proven stack to `home-lab/k8s-cluster` as Flux-managed resources (Multica `HelmRelease` + `HelmRepository`, daemon Deployment, Guild conductor, ESO-backed secrets rendering the normative Secret names), making the deferred calls here: Multica Postgres final placement, exposure/DNS, gateway topology (fold Guild's routes into the shared LiteLLM vs. keep the separate instance). Remove all ad-hoc dev resources after cutover.

> Former acceptance: Flux reconciles the whole stack from git on a clean cluster + the M2 flow entirely in-cluster; zero ad-hoc resources remain.

## Personal open questions (formerly ARCHITECTURE.md OQ6/OQ7, plus the OQ5 placement clause)

> 6. Final exposure: `*.bitstrum.com` currently resolves to NPM, not the in-cluster Envoy Gateway (cutover rolled back 2026-07-20). Dev phase is port-forward/internal-only; decide at the (personal) promotion.
>
> 7. Gateway topology at promotion: fold Guild's `anthropic/*` routes into the shared Flux-managed LiteLLM (ns `litellm`, shared with Home Assistant voice) vs. keep Guild's separate instance permanently.
>
> (from OQ5) The promotion picks this cluster's permanent datastore mode.

## Isolation exclusion list (referenced by the ROADMAP "test like a new user" rule)

Guild dev/test uses zero pre-existing homelab services: not the shared LiteLLM, not `dbsrv01`, not the Ollama VMs.
