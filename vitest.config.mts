import { defineConfig } from "vitest/config";

/**
 * The SDK holds no alias and reads no environment variable, so this config
 * names only the files to run.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
