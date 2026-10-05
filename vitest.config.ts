import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Run tests against core's TypeScript source, so nothing needs building first.
    conditions: ["source"],
  },
  ssr: {
    resolve: { conditions: ["source"] },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
