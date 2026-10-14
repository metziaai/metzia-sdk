#!/usr/bin/env node
/**
 * Loads the built package the way a seller loads it.
 *
 * The unit tests run the TypeScript sources, so they prove nothing about the
 * `exports` map, the two module formats, or the file names `tsup` writes. This
 * script reaches the package by name, so the resolver reads the `exports` map
 * and picks one file per condition. It loads the main entry and the testing
 * subpath, both by name, under `import` and under `require`. Run it after
 * `npm run build`.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";

// A key shaped like a real one, and obviously not one.
const KEY = "key-for-the-smoke-test";
// A secret shaped like a real one, and obviously not one.
const SECRET = "secret-for-the-smoke-test";

const require = createRequire(import.meta.url);

/** Checks one built entry point. `label` names it in the failure line. */
function check(label, entry) {
  const { Market, MarketValidationError, validateListing } = entry;
  assert.equal(typeof Market, "function", `${label}: Market is not exported.`);
  assert.equal(
    typeof validateListing,
    "function",
    `${label}: validateListing is not exported.`,
  );
  assert.equal(
    typeof MarketValidationError,
    "function",
    `${label}: MarketValidationError is not exported.`,
  );

  assert.throws(
    () => validateListing({}),
    (error) => error instanceof MarketValidationError,
    `${label}: invalid listings must throw MarketValidationError.`,
  );

  const market = new Market(KEY);
  assert.equal(
    market.baseUrl,
    "https://api.metzia.ai",
    `${label}: the default base URL changed.`,
  );

  const other = new Market(KEY, { baseUrl: "http://localhost:3000" });
  assert.equal(
    other.baseUrl,
    "http://localhost:3000",
    `${label}: the baseUrl option did not change the host.`,
  );

  assert.throws(
    () => new Market(""),
    /PLATFORM_KEY/,
    `${label}: an empty key must throw and name PLATFORM_KEY.`,
  );

  // The receiver is a setup surface, not a public secret. Without a configured
  // secret it refuses, and with one it returns a Request to Response function.
  assert.throws(
    () => market.webhooks.handler(),
    /webhookSecret/,
    `${label}: handler() must throw and name webhookSecret when none is set.`,
  );
  assert.equal(
    typeof new Market(KEY, { webhookSecret: SECRET }).webhooks.handler(),
    "function",
    `${label}: a configured secret must build a receiver function.`,
  );

  process.stdout.write(`${label}: ok\n`);
}

/** Checks one test-signer entry point. `label` names it in the failure line. */
function checkTesting(label, testing) {
  assert.equal(
    typeof testing.signTestEvent,
    "function",
    `${label}: signTestEvent is not exported.`,
  );

  process.stdout.write(`${label}: ok\n`);
}

try {
  const esm = await import("@metzia/sdk");
  check("import condition", esm);

  assert.equal(
    esm.signTestEvent,
    undefined,
    "the root entry must not export signTestEvent.",
  );

  const cjs = require("@metzia/sdk");
  check("require condition", cjs);

  assert.equal(
    cjs.signTestEvent,
    undefined,
    "the root entry must not export signTestEvent.",
  );

  const esmTesting = await import("@metzia/sdk/testing");
  checkTesting("import testing condition", esmTesting);

  const cjsTesting = require("@metzia/sdk/testing");
  checkTesting("require testing condition", cjsTesting);

  process.stdout.write(
    "smoke passed. Both conditions load the main entry and the testing subpath.\n",
  );
} catch (error) {
  process.stderr.write(`smoke failed. ${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write("Run `npm run build` first, then read the assertion above.\n");
  process.exitCode = 1;
}
