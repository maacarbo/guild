# docker/daemon — custom Multica daemon image (M1)

Multica publishes no daemon container (host-only by stated design); this image is Guild's contribution. Contents per the verified deployment sketch in `docs/research/multica-investigation-2026-07-29.md`:

- `multica` CLI binary; bundled agent CLIs: **OpenCode (default, D9) + Claude Code**, each with its own auth env
- git + credentials (mounted, never baked into the image)
- Entrypoint: `multica login --token $MULTICA_DAEMON_TOKEN` (headless — interactive login opens a browser and cannot work in a container), then `multica daemon start --foreground` as PID 1
- Agent CLIs pointed at the LiteLLM gateway so every model call is metered (D2): Claude Code via `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`; OpenCode via the baked `opencode.json` declaring `litellm` as a custom provider (`{env:GUILD_DAEMON_VIRTUAL_KEY}` — OpenCode agents use `provider/model`-qualified models, e.g. `litellm/or-claude-haiku-4-5`)

**Version discipline (Anthropic review 2026-07-30):** the image bundles independently-drifting parties — the `multica` binary, the agent CLIs (Claude Code, OpenCode), and this Dockerfile. All binaries are **pinned as build args**; autoupdaters are **disabled** in the image (env for Claude Code, baked config for OpenCode); the pinned Multica version (compose image tag on Tier 1; chart version on Kubernetes) and this image are declared a **lockstep pair** (bump together, run the substrate conformance suite green before either moves). Session dirs are ephemeral by default (no bind mount on compose; `emptyDir` on Kubernetes) — bounce continuity after a restart (container on Tier 1, pod on Kubernetes) is best-effort by design (bounce comments are self-contained).

**Status: proven end-to-end (2026-07-30).** Claude Code path: probe P3 in `docs/research/capability-matrix-m1a.md` (task claim → completion → branch push). OpenCode path: addendum P16, same matrix. **amd64-only** — further runtimes and architectures are added per role when a role needs them.
