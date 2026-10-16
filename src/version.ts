/**
 * The version the `User-Agent` header reports.
 *
 * A constant, not an import of `package.json`. An import would put the whole
 * manifest in the bundle. `version.test.ts` reads the manifest instead and
 * fails when the two numbers differ. The release tooling moves both.
 */
export const SDK_VERSION = "0.1.2";
