import { defineConfig } from "vitest/config";

/**
 * The SDK holds no alias and reads no environment variable, so this config
 * names only the files to run.
 *
 * `test/` holds checks that read the platform documentation. It exists only
 * where that documentation lives, and the glob matches nothing elsewhere.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    passWithNoTests: false,
  },
});
