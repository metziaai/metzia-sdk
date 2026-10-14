/**
 * The seller event contracts and the private registry that holds their
 * handlers.
 *
 * Two events reach a seller: the platform provisions a buyer's account after a
 * purchase, and it cancels one. `Market.on` refuses any other event name.
 *
 * The handler types and the registry are internal: the package
 * entry point does not re-export them, and the webhook receiver reads through
 * the narrow accessor rather than a public method.
 */

/** The platform provisioned, or needs to provision, a buyer's account. */
export type ProvisionEvent = {
  /** The buyer id the platform issued. It is the join key, never an email. */
  buyerId: string;
  /** The product the buyer purchased. */
  sku: string;
  /** The order that carries the purchase. */
  orderId: string;
};

/** The answer a provision handler returns. */
export type ProvisionResult = {
  /** The seller's own account id, for the later cancel and support calls. */
  externalAccountId: string;
  /**
   * True when the handler created the account, false when it linked one the
   * buyer already held. A retry therefore reaches the same state.
   */
  created: boolean;
};

/** The platform cancelled a buyer's account. */
export type CancelEvent = {
  /** The seller's account id, returned by the earlier provision call. */
  externalAccountId: string;
  /** The product whose entitlement is revoked. */
  sku: string;
};

/**
 * Every event a seller may register.
 *
 * A name outside this union is a compile error.
 */
export type MarketEventName = "provision" | "cancel";

/**
 * Internal. The shape of a provision registration.
 *
 * The resolved result is exact: a seller must answer with an
 * `externalAccountId` and a `created` flag.
 */
export type ProvisionHandler = (
  event: ProvisionEvent,
) => ProvisionResult | Promise<ProvisionResult>;

/**
 * Internal. The shape of a cancel registration.
 *
 * The receiver ignores the result, so a cancel handler may be synchronous or
 * asynchronous and may resolve to anything.
 */
export type CancelHandler = (event: CancelEvent) => unknown;

/** Internal. One handler for each event, keyed by the event name. */
export type MarketEventHandlerMap = {
  provision: ProvisionHandler;
  cancel: CancelHandler;
};

/**
 * Internal. The one registry of handlers for each `Market` instance.
 *
 * A `WeakMap` keeps the handlers off the public class and lets the webhook
 * receiver read them with no public method. The key is the instance itself, so
 * two sellers never share a handler and a discarded instance drops its own.
 */
const handlerRegistries = new WeakMap<object, Partial<MarketEventHandlerMap>>();

/** Internal. Reads the registry of one instance, creating it on first use. */
function registryOf(market: object): Partial<MarketEventHandlerMap> {
  let registry = handlerRegistries.get(market);

  if (registry === undefined) {
    registry = {};
    handlerRegistries.set(market, registry);
  }

  return registry;
}

/**
 * Internal. `Market.on` writes through this.
 *
 * A second registration for the same event replaces the first, because the
 * assignment overwrites the one key.
 */
export function setMarketHandler<K extends MarketEventName>(
  market: object,
  event: K,
  handler: MarketEventHandlerMap[K],
): void {
  registryOf(market)[event] = handler;
}

/** Internal. The webhook receiver and the tests read through this. */
export function getMarketHandler<K extends MarketEventName>(
  market: object,
  event: K,
): MarketEventHandlerMap[K] | undefined {
  return registryOf(market)[event];
}

/**
 * Internal. Narrows an unchecked JavaScript value to a known event name.
 *
 * A TypeScript caller cannot reach the guard, because the name type holds only
 * the two events. A JavaScript caller can pass any string, so `Market.on`
 * checks before it writes.
 */
export function isMarketEventName(value: unknown): value is MarketEventName {
  return value === "provision" || value === "cancel";
}
