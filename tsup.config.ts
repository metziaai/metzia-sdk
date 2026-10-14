import { defineConfig } from "tsup";

/**
 * Three entry points, two module formats, one declaration file each.
 *
 * A seller reaches the main package through `import` or through `require`, and
 * the test signer reaches the `./testing` subpath the same way. The `exports`
 * map in `package.json` names one file for each. `outExtension` keeps the two
 * module formats apart: `.js` for the ESM build, `.cjs` for CommonJS. The
 * package is `"type": "module"`, so Node reads a bare `.js` file as ESM.
 */
export default defineConfig({
  // `src/cli.ts` backs the `market` command. `bin/market.mjs` imports its ESM
  // build, and no `exports` entry names it, so no seller import reaches it.
  entry: ["src/index.ts", "src/testing.ts", "src/cli.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  // Sellers install Zod beside the SDK. Do not duplicate it in either bundle.
  external: ["zod"],
  // The lowest runtime `engines` allows. A seller chooses the runtime.
  target: "node20",
  outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
});
