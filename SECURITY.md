# Security Policy

The supported release line is `v0.1.x` (first shipped as `v0.1.0`, GHCR images + git tag). Report against the latest release or `main`.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (**Security → Report a vulnerability**). Please do not open public issues for exploitable problems.

## Threat model and accepted risks

Guild executes LLM-generated code by design. The current security posture — what the Tier 1 compose deployment does and deliberately does not provide (no kernel sandboxing, no FQDN egress control; the container boundary, budget-capped virtual keys, and the credential-free `--network none` validator sandbox are the enforced controls) — is documented in [deploy/README.md — Security floor](deploy/README.md). Hardening beyond that floor is deployment-specific and lands with the optional M4 milestone.
