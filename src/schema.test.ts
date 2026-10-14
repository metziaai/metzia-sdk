import { describe, expect, it, vi } from "vitest";

import { DELIVERS } from "./catalog-fields";
import { MarketValidationError } from "./errors";
import { listingSchema, validateListing, type ListingInput } from "./schema";

const NOT_A_FIT =
  "A one-person team that prefers to keep every customer record in a spreadsheet.";

function listing(overrides: Partial<ListingInput> = {}): ListingInput {
  return {
    sku: "crm-pro",
    name: "CRM Pro",
    destinationPath: "/products/crm-pro",
    categorySlug: "crm",
    pricingModel: "seat",
    delivers: "seats",
    provisioning: "delegated",
    summary: "A CRM for growing service teams.",
    notAFitWhen: NOT_A_FIT,
    pricePoints: [{ amountMicros: 25_000_000, unitName: "per seat per month" }],
    ...overrides,
  };
}

function errors(input: unknown): readonly { field: string; rule: string; message: string }[] {
  try {
    validateListing(input);
  } catch (error) {
    expect(error).toBeInstanceOf(MarketValidationError);
    return (error as MarketValidationError).errors;
  }
  throw new Error("Expected listing validation to fail.");
}

describe("the SDK listing wire schema", () => {
  it("accepts server field names, shipment, and integer micro USD", () => {
    const result = validateListing(listing({ delivers: "shipment" }));

    expect(DELIVERS).toContain("shipment");
    expect(result.pricePoints[0].amountMicros).toBe(25_000_000);
    expect(result.description).toBeNull();
    expect(result.integrations).toEqual([]);
  });

  it("is strict at the listing and price point levels", () => {
    expect(errors({ ...listing(), categories: ["crm"] })[0]).toMatchObject({
      field: "categories",
      rule: "unknown",
    });
    expect(
      errors(
        listing({
          pricePoints: [
            { amountMicros: 1, unitName: "license", currency: "USD" } as never,
          ],
        }),
      )[0],
    ).toMatchObject({ field: "pricePoints.0.currency", rule: "unknown" });
  });

  it.each([49.5, -1, Number.NaN])("rejects the invalid micro amount %s", (amountMicros) => {
    const issue = errors(
      listing({ pricePoints: [{ amountMicros, unitName: "per seat" }] }),
    ).find((entry) => entry.field === "pricePoints.0.amountMicros");

    expect(issue?.rule).toMatch(/integer|min/);
  });

  it("enforces every closed union", () => {
    for (const [field, value] of [
      ["pricingModel", "auction"],
      ["delivers", "cash"],
      ["provisioning", "manual"],
    ] as const) {
      expect(errors({ ...listing(), [field]: value })[0]).toMatchObject({ field, rule: "enum" });
    }

    expect(
      errors(
        listing({
          pricePoints: [{ amountMicros: 1, unitName: "license", interval: "week" as never }],
        }),
      )[0],
    ).toMatchObject({ field: "pricePoints.0.interval", rule: "enum" });
  });

  it("requires a seller relative destination path", () => {
    expect(errors({ ...listing(), destinationPath: undefined })[0]).toMatchObject({
      field: "destinationPath",
      rule: "required",
    });

    for (const value of [
      "",
      "products/crm-pro",
      "https://seller.example/products/crm-pro",
      "//evil.example/x",
      "/products\\crm-pro",
      "/products/../admin",
      "/products/%2e%2e/admin",
    ]) {
      expect(errors(listing({ destinationPath: value }))[0]).toMatchObject({
        field: "destinationPath",
        rule: "invalid",
      });
    }

    expect(validateListing(listing()).destinationPath).toBe("/products/crm-pro");
  });

  it("enforces identifiers, prose lengths, slugs, and text limits", () => {
    expect(errors(listing({ sku: "" }))[0]).toMatchObject({ field: "sku", rule: "too_short" });
    expect(errors(listing({ categorySlug: "Not A Slug" }))[0]).toMatchObject({
      field: "categorySlug",
      rule: "format",
    });
    expect(errors(listing({ summary: "x".repeat(281) }))[0]).toMatchObject({
      field: "summary",
      rule: "max",
    });
    expect(errors(listing({ description: "x".repeat(4001) }))[0]).toMatchObject({
      field: "description",
      rule: "max",
    });
    expect(errors(listing({ notAFitWhen: `   ${"x".repeat(39)}   ` }))[0]).toMatchObject({
      field: "notAFitWhen",
      rule: "too_short",
    });
    expect(
      errors(
        listing({ pricePoints: [{ amountMicros: 1, unitName: "x".repeat(41) }] }),
      )[0],
    ).toMatchObject({ field: "pricePoints.0.unitName", rule: "max" });
  });

  it("requires nonnegative integer limit values", () => {
    expect(errors(listing({ limits: { seats: 2.5 } }))[0]).toMatchObject({
      field: "limits.seats",
      rule: "integer",
    });
    expect(errors(listing({ limits: { seats: -1 } }))[0]).toMatchObject({
      field: "limits.seats",
      rule: "min",
    });
  });

  /**
   * The publish API stores a boolean limit, and the vocabulary's `value_type`
   * decides which form a key takes. The SDK refused one locally before.
   */
  it("accepts a boolean limit value", () => {
    expect(validateListing(listing({ limits: { sso: true, seats: 10 } })).limits).toEqual({
      sso: true,
      seats: 10,
    });
  });

  it("refuses a value that is neither a whole number nor a boolean", () => {
    expect(errors(listing({ limits: { seats: "3" as unknown as number } }))[0]).toMatchObject({
      field: "limits.seats",
      rule: "type",
    });
  });

  /** The API answers 422 for such a key, so the local check refuses it first. */
  it.each(["Seats", "seats-per-org", "1seats", ""])("refuses the limit key %j", (key) => {
    expect(errors(listing({ limits: { [key]: 1 } }))[0]).toMatchObject({
      field: `limits.${key}`,
      rule: "format",
      message: expect.stringContaining("A limit key is a vocabulary key"),
    });
  });

  it("requires tier bounds only for tiered pricing", () => {
    expect(
      errors(
        listing({
          pricePoints: [{ amountMicros: 1, unitName: "seat", tierMin: 0, tierMax: 10 }],
        }),
      )[0],
    ).toMatchObject({ field: "pricePoints.0", rule: "enum" });

    const tiered = validateListing(
      listing({
        pricingModel: "tiered",
        pricePoints: [
          { amountMicros: 10, unitName: "request", tierMin: 0, tierMax: 100 },
          { amountMicros: 8, unitName: "request", tierMin: 100, tierMax: null },
        ],
      }),
    );
    expect(tiered.pricePoints).toHaveLength(2);

    expect(
      errors(
        listing({
          pricingModel: "tiered",
          pricePoints: [{ amountMicros: 10, unitName: "request" }],
        }),
      )[0],
    ).toMatchObject({ field: "pricePoints.0" });
  });

  it("requires unique plan names when a non-tiered listing has several prices", () => {
    const missing = errors(
      listing({
        pricePoints: [
          { amountMicros: 1, unitName: "month", plan: "Pro" },
          { amountMicros: 2, unitName: "month" },
        ],
      }),
    );
    expect(missing).toContainEqual(expect.objectContaining({
      field: "pricePoints.1.plan",
      rule: "required",
    }));

    const duplicate = errors(
      listing({
        pricePoints: [
          { amountMicros: 1, unitName: "month", plan: "Pro" },
          { amountMicros: 2, unitName: "month", plan: "pro" },
        ],
      }),
    );
    expect(duplicate).toContainEqual(expect.objectContaining({
      field: "pricePoints.1.plan",
      rule: "enum",
    }));
  });

  it("collects three bad fields with stable dotted paths", () => {
    const found = errors(
      listing({
        name: "",
        summary: "x".repeat(281),
        pricePoints: [{ amountMicros: 1.5, unitName: "seat" }],
      }),
    );

    expect(found).toHaveLength(3);
    expect(found.map((issue) => issue.field)).toEqual([
      "name",
      "summary",
      "pricePoints.0.amountMicros",
    ]);
  });

  it("preserves readonly errors and JSON wire field names", () => {
    const failure = new MarketValidationError(errors(listing({ notAFitWhen: "short" })));
    const json = failure.toJSON();

    expect(failure.name).toBe("MarketValidationError");
    expect(Object.isFrozen(failure.errors)).toBe(true);
    expect(json.errors[0].field).toBe("notAFitWhen");
    expect(JSON.parse(JSON.stringify(failure))).toEqual(json);
  });

  it("never calls fetch", () => {
    const fetch = vi.spyOn(globalThis, "fetch");

    expect(() => validateListing(listing())).not.toThrow();
    expect(() => validateListing(listing({ name: "" }))).toThrow(MarketValidationError);
    expect(fetch).not.toHaveBeenCalled();

    fetch.mockRestore();
  });

  it("exports a Zod 4 schema for callers that need safeParse", () => {
    expect(listingSchema.safeParse(listing()).success).toBe(true);
  });
});
