import { defineConfig } from "vitest/config";

// Two tiers per CLAUDE.md: unit tests (domain/ mapping — pure, always run) and
// adapter integration tests against the live compose stack. Integration specs
// are named *.live.test.ts and only run when GUILD_LIVE_STACK is set — CI has
// no stack; `pnpm test:live` (and the smoke entrypoint) sets it locally.
export default defineConfig({
  test: {
    include: process.env.GUILD_LIVE_STACK
      ? ["src/**/*.test.ts", "src/**/*.live.test.ts"]
      : ["src/**/*.test.ts"],
    exclude: process.env.GUILD_LIVE_STACK
      ? ["**/node_modules/**"]
      : ["**/node_modules/**", "src/**/*.live.test.ts"],
    // live tests create real work items and wait on a real daemon
    testTimeout: process.env.GUILD_LIVE_STACK ? 180_000 : 5_000,
    hookTimeout: process.env.GUILD_LIVE_STACK ? 60_000 : 5_000,
  },
});
