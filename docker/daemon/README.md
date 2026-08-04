# docker/daemon — custom Multica daemon image (M1)

Multica publishes no daemon container (host-only by stated design); this image is Guild's contribution. Contents per the verified deployment sketch in `docs/research/multica-investigation-2026-07-29.md`:

- `multica` CLI binary; bundled agent CLI: **OpenCode (sole runtime — D9 as amended 2026-08-04**; MIT-licensed, hence redistributable in this public image. Claude Code was dropped by that amendment: proprietary "all rights reserved" npm package on a publicly published image, and model reach never depended on it — issue #13)
- git + credentials (mounted, never baked into the image)
- Entrypoint: `multica login --token $MULTICA_DAEMON_TOKEN` (headless — interactive login opens a browser and cannot work in a container), then `multica daemon start --foreground` as PID 1
- The agent CLI is pointed at the LiteLLM gateway so every model call is metered (D2): the baked `opencode.json` declares `litellm` as a custom provider (`{env:GUILD_DAEMON_VIRTUAL_KEY}` — OpenCode agents use `provider/model`-qualified models, e.g. `litellm/or-claude-haiku-4-5`)

**Version discipline (Anthropic review 2026-07-30):** the image bundles independently-drifting parties — the `multica` binary, the agent CLI, and this Dockerfile. All binaries are **pinned as build args**; autoupdates are **disabled** (OpenCode's baked config); the pinned Multica version (compose image tag on Tier 1; chart version on Kubernetes) and this image are declared a **lockstep pair** (bump together, run the substrate conformance suite green before either moves). Session dirs are ephemeral by default (no bind mount on compose; `emptyDir` on Kubernetes) — bounce continuity after a restart (container on Tier 1, pod on Kubernetes) is best-effort by design (bounce comments are self-contained).

**Status: proven end-to-end (2026-07-30).** OpenCode path: addendum P16 in `docs/research/capability-matrix-m1a.md` (task claim → completion → branch push; the original P3 proof ran on Claude Code, since removed from the image). **amd64-only** — further runtimes and architectures are added per role when a role needs them.
