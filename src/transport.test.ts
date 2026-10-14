import { describe, expect, it } from "vitest";

import { backoffMs, FIRST_BACKOFF_MS } from "./transport";

describe("backoffMs", () => {
  it("waits between half and all of the doubled ceiling", () => {
    for (const attempt of [0, 1, 2]) {
      const ceiling = FIRST_BACKOFF_MS * 2 ** attempt;

      expect(backoffMs(attempt, () => 0)).toBe(ceiling / 2);
      expect(backoffMs(attempt, () => 0.999_999)).toBe(ceiling);
    }
  });

  it("spreads the waits of clients that fail together", () => {
    const waits = new Set([0.1, 0.4, 0.7].map((point) => backoffMs(1, () => point)));

    expect(waits.size).toBe(3);
  });
});
