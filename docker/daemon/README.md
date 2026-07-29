# docker/daemon — custom Multica daemon image (M1)

Multica publishes no daemon container (host-only by stated design); this image is Guild's contribution. Contents per the verified deployment sketch in `docs/research/multica-investigation-2026-07-29.md`:

- `multica` CLI binary; agent CLIs (claude, opencode, …) with their own API keys via env
- git + credentials (mounted, never baked into the image)
- Entrypoint: `multica login --token $MULTICA_DAEMON_TOKEN` (headless — interactive login opens a browser and cannot work in a pod), then `multica daemon start --foreground` as PID 1
- Agent CLIs pointed at the LiteLLM gateway (`ANTHROPIC_BASE_URL`, …) so every model call is metered (D2)

**Status: untested end-to-end.** Building and proving this container (task claim → completion) is the first M1 task; nothing else in the roadmap proceeds on the assumption it works.
