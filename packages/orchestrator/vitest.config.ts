import { defineConfig } from "vitest/config";

// Same two tiers as substrate-multica: pure unit tests always; live specs
// (*.live.test.ts — need docker + repo access) only under GUILD_LIVE_STACK.
export default defineConfig({
  test: {
    include: process.env.GUILD_LIVE_STACK
      ? ["src/**/*.test.ts", "src/**/*.live.test.ts"]
      : ["src/**/*.test.ts"],
    exclude: process.env.GUILD_LIVE_STACK
      ? ["**/node_modules/**"]
      : ["**/node_modules/**", "src/**/*.live.test.ts"],
    testTimeout: process.env.GUILD_LIVE_STACK ? 300_000 : 5_000,
    hookTimeout: process.env.GUILD_LIVE_STACK ? 60_000 : 5_000,
  },
});
