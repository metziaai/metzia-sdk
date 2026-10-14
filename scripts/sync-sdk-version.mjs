#!/usr/bin/env node
/**
 * Copies the SDK version from `package.json` into `src/version.ts`.
 *
 * `changeset version` moves the version in the manifest and nothing else.
 * `SDK_VERSION` is a constant, so the `User-Agent` header and
 * `market --version` read no manifest at run time. `npm run version-packages` runs
 * this file after `changeset version`, so the version pull request moves both
 * numbers. `src/version.test.ts` fails when they differ.
 *
 * | Failure | Output | Exit code |
 * |---|---|---|
 * | The manifest version is not a semantic version | The version it read | 1 |
 * | `version.ts` holds no `SDK_VERSION` line, or more than one | The file it read | 1 |
 *
 * Usage:
 *   node scripts/sync-sdk-version.mjs              (this package)
 *   node scripts/sync-sdk-version.mjs <package-dir> (a test tree)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const OWN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** A release version, with an optional pre-release part such as `-next.0`. */
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const CONSTANT = /^export const SDK_VERSION = "[^"\n]*";$/gm;

function main() {
  const packageDir = process.argv[2] ?? OWN_ROOT;
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const version = manifest.version;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    console.error(`sync-sdk-version failed. The manifest version "${String(version)}" is not a semantic version.`);
    return 1;
  }

  const file = join(packageDir, "src", "version.ts");
  const label = relative(process.cwd(), file).split("\\").join("/");
  const source = readFileSync(file, "utf8");
  const lines = source.match(CONSTANT) ?? [];
  if (lines.length !== 1) {
    console.error(
      `sync-sdk-version failed. ${label} must hold exactly one line of the form export const SDK_VERSION = "<version>"; and it holds ${lines.length}.`,
    );
    return 1;
  }

  const next = source.replace(CONSTANT, `export const SDK_VERSION = "${version}";`);
  if (next === source) {
    console.log(`sync-sdk-version: ${label} already holds ${version}.`);
    return 0;
  }
  writeFileSync(file, next);
  console.log(`sync-sdk-version: wrote ${version} to ${label}.`);
  return 0;
}

process.exitCode = main();
