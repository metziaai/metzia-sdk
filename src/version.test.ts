import { describe, expect, it } from "vitest";

import manifest from "../package.json";
import { SDK_VERSION } from "./version";

describe("SDK_VERSION", () => {
  it("equals the version in package.json", () => {
    // The header a seller's API log shows must name the version they installed.
    // Two places hold the number, so one test keeps them equal.
    expect(SDK_VERSION).toBe(manifest.version);
  });
});
