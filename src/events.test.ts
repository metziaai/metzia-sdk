import { describe, expect, it } from "vitest";

import {
  getMarketHandler,
  isMarketEventName,
  setMarketHandler,
  type CancelEvent,
  type MarketEventName,
  type ProvisionEvent,
  type ProvisionResult,
} from "./events";

/**
 * Fails to compile unless two types are identical.
 *
 * A missing field, an extra field, or a changed type makes `Equal` false, and
 * the `true` constraint of `assertTrue` refuses the call. The pair holds each
 * event contract to the fields the section *The seller surface* documents.
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Compile-time assertion. It returns its argument, so a passing call costs nothing. */
function assertTrue<T extends true>(value: T): T {
  return value;
}

describe("the event contracts", () => {
  it("matches the documented fields exactly", () => {
    assertTrue<
      Equal<ProvisionEvent, { buyerId: string; sku: string; orderId: string }>
    >(true);
    assertTrue<
      Equal<ProvisionResult, { externalAccountId: string; created: boolean }>
    >(true);
    assertTrue<Equal<CancelEvent, { externalAccountId: string; sku: string }>>(
      true,
    );
    assertTrue<Equal<MarketEventName, "provision" | "cancel">>(true);
  });

  it("answers for the two names and no other", () => {
    expect(isMarketEventName("provision")).toBe(true);
    expect(isMarketEventName("cancel")).toBe(true);
    expect(isMarketEventName("reserve")).toBe(false);
    expect(isMarketEventName("confirm")).toBe(false);
    expect(isMarketEventName(undefined)).toBe(false);
    expect(isMarketEventName(7)).toBe(false);
  });
});

describe("the handler registry", () => {
  it("reads back the handler a registration wrote", () => {
    const market = {};
    const handler = (event: ProvisionEvent): ProvisionResult => ({
      externalAccountId: event.buyerId,
      created: true,
    });

    setMarketHandler(market, "provision", handler);

    expect(getMarketHandler(market, "provision")).toBe(handler);
  });

  it("answers undefined before any registration", () => {
    expect(getMarketHandler({}, "cancel")).toBeUndefined();
  });

  it("replaces the handler of an event registered twice", () => {
    const market = {};
    const first = (): void => {};
    const second = (): void => {};

    setMarketHandler(market, "cancel", first);
    setMarketHandler(market, "cancel", second);

    expect(getMarketHandler(market, "cancel")).toBe(second);
  });

  it("keeps the registries of two instances apart", () => {
    const a = {};
    const b = {};
    const handler = (): void => {};

    setMarketHandler(a, "cancel", handler);

    expect(getMarketHandler(a, "cancel")).toBe(handler);
    expect(getMarketHandler(b, "cancel")).toBeUndefined();
  });
});
