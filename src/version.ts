/**
 * The version the `User-Agent` header reports.
 *
 * A constant, not an import of `package.json`. An import would put the whole
 * manifest in the bundle. `version.test.ts` reads the manifest instead and
 * fails when the two numbers differ. `npm run version-packages` moves both: it
 * runs `changeset version`, then `scripts/sync-sdk-version.mjs` copies the
 * manifest version here.
 */
export const SDK_VERSION = "0.1.0";
