import { afterEach, describe, expect, it, vi } from "vitest";

import type { CancelEvent, ProvisionEvent } from "./events";
import { getMarketHandler } from "./events";
import {
  DEFAULT_BASE_URL,
  invalidHandlerMessage,
  Market,
  unsupportedEventMessage,
} from "./market";
import { MISSING_WEBHOOK_SECRET_MESSAGE } from "./webhooks";

const KEY = "test-key";
const SECRET = "test-webhook-secret";

/**
 * Answers every call with the same 200, and records what it received. The type
 * argument gives `spy.mock.calls[0]` its tuple type.
 */
function stubFetch() {
  const spy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("new Market", () => {
  it("throws on an empty key and names METZIA_KEY", () => {
    expect(() => new Market("")).toThrow(/METZIA_KEY/);
  });

  it("throws on a whitespace key and names METZIA_KEY", () => {
    expect(() => new Market("   ")).toThrow(/METZIA_KEY/);
  });

  it("throws on a missing key and names METZIA_KEY", () => {
    expect(() => new Market(undefined)).toThrow(/METZIA_KEY/);
  });

  it("states what to do in the message", () => {
    expect(() => new Market("")).toThrow(
      "Market needs a Metzia seller key. Set METZIA_KEY and pass process.env.METZIA_KEY to new Market().",
    );
  });

  it("takes the production host by default", () => {
    expect(new Market(KEY).baseUrl).toBe(DEFAULT_BASE_URL);
    expect(DEFAULT_BASE_URL).toBe("https://api.metzia.ai");
  });

  it("takes the host the caller gives", () => {
    const market = new Market(KEY, { baseUrl: "http://localhost:3000" });

    expect(market.baseUrl).toBe("http://localhost:3000");
  });

  it("throws on an empty base URL and says what to pass", () => {
    expect(() => new Market(KEY, { baseUrl: "" })).toThrow(
      /Pass an absolute https URL with no query and no fragment/,
    );
  });

  it("throws on a base URL with no scheme", () => {
    expect(() => new Market(KEY, { baseUrl: "api.metzia.ai" })).toThrow(
      /Market cannot use the base URL/,
    );
  });

  it("throws on a base URL that carries a query", () => {
    expect(() => new Market(KEY, { baseUrl: `${DEFAULT_BASE_URL}?v=1` })).toThrow(
      /Market cannot use the base URL/,
    );
  });

  it.each(["http://api.metzia.ai", "http://sandbox.metzia.ai", "http://10.0.0.5:3000", "ftp://api.metzia.ai"])(
    "throws on %s, because every call would carry the key in clear text",
    (baseUrl) => {
      expect(() => new Market(KEY, { baseUrl })).toThrow(/Plain http is allowed for localhost only/);
    },
  );

  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000", "https://sandbox.metzia.ai"])(
    "takes %s",
    (baseUrl) => {
      expect(new Market(KEY, { baseUrl }).baseUrl).toBe(baseUrl);
    },
  );

  it("throws on a base URL that carries a fragment", () => {
    expect(() => new Market(KEY, { baseUrl: `${DEFAULT_BASE_URL}#top` })).toThrow(
      /Market cannot use the base URL/,
    );
  });
});

describe("Market.request", () => {
  it("calls the configured host with the key of the instance", async () => {
    const spy = stubFetch();

    const market = new Market(KEY, { baseUrl: "http://localhost:3000/" });
    const result = await market.request<{ ok: boolean }>("/products");

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("http://localhost:3000/products");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
    expect(result).toEqual({ ok: true, status: 200, body: { ok: true } });
  });

  it("sends the trimmed key", async () => {
    const spy = stubFetch();

    await new Market(`  ${KEY}  `).request("/products");

    const [, init] = spy.mock.calls[0];
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
  });
});

describe("Market.on", () => {
  it("stores the provision handler", () => {
    const market = new Market(KEY);
    const handler = (event: ProvisionEvent) => ({
      externalAccountId: event.buyerId,
      created: true,
    });

    market.on("provision", handler);

    expect(getMarketHandler(market, "provision")).toBe(handler);
  });

  it("stores the cancel handler", () => {
    const market = new Market(KEY);
    const handler = (event: CancelEvent): void => {
      void event.externalAccountId;
    };

    market.on("cancel", handler);

    expect(getMarketHandler(market, "cancel")).toBe(handler);
  });

  it("replaces a handler registered twice for one event", () => {
    const market = new Market(KEY);
    const first = (): void => {};
    const second = (): void => {};

    market.on("cancel", first);
    market.on("cancel", second);

    expect(getMarketHandler(market, "cancel")).toBe(second);
  });

  it("keeps the handlers of two instances apart", () => {
    const first = new Market(KEY);
    const second = new Market(KEY);
    const handler = (): void => {};

    first.on("cancel", handler);

    expect(getMarketHandler(first, "cancel")).toBe(handler);
    expect(getMarketHandler(second, "cancel")).toBeUndefined();
  });

  it("refuses an unsupported name and names it", () => {
    const market = new Market(KEY);

    // The cast reaches the guard a JavaScript caller hits. TypeScript refuses
    // the same call below, so the two lines cover both readers.
    expect(() =>
      (market.on as (event: string, handler: () => void) => void)(
        "reserve",
        () => {},
      ),
    ).toThrow(unsupportedEventMessage("reserve"));
  });

  it("refuses a handler that is not callable and names the event", () => {
    const market = new Market(KEY);

    // A JavaScript caller reaches this. Without the guard the bad value is
    // stored and only surfaces as an opaque 500 on the first real callback.
    expect(() =>
      (market.on as (event: string, handler: unknown) => void)(
        "cancel",
        "not-a-function",
      ),
    ).toThrow(invalidHandlerMessage("cancel", "not-a-function"));

    expect(getMarketHandler(market, "cancel")).toBeUndefined();
  });

  it("refuses an omitted handler", () => {
    const market = new Market(KEY);

    expect(() =>
      (market.on as (event: string, handler?: unknown) => void)("provision"),
    ).toThrow(/needs a function/);
  });

  it("refuses reserve and confirm at compile time and at run time", () => {
    const market = new Market(KEY);

    expect(() => {
      // @ts-expect-error reserve is not a seller event
      market.on("reserve", () => {});
    }).toThrow(/reserve/);

    expect(() => {
      // @ts-expect-error confirm is not a seller event
      market.on("confirm", () => {});
    }).toThrow(/confirm/);
  });

  it("gives each handler its exact payload", () => {
    const market = new Market(KEY);

    market.on("provision", (event) => {
      const exact: ProvisionEvent = event;
      return { externalAccountId: exact.buyerId, created: false };
    });

    market.on("cancel", (event) => {
      const exact: CancelEvent = event;
      void exact.sku;
    });

    expect(getMarketHandler(market, "provision")).toBeTypeOf("function");
    expect(getMarketHandler(market, "cancel")).toBeTypeOf("function");
  });

  it("compiles and runs the documented upsert on platformId snippet", async () => {
    const market = new Market(KEY);

    const db = {
      users: {
        upsert: async ({ platformId }: { platformId: string }) => ({
          id: `usr_${platformId}`,
          isNew: true,
        }),
      },
      entitlements: {
        grant: async (userId: string, sku: string): Promise<void> => {
          void userId;
          void sku;
        },
      },
    };

    market.on("provision", async ({ buyerId, sku, orderId }) => {
      const user = await db.users.upsert({ platformId: buyerId });
      await db.entitlements.grant(user.id, sku);
      void orderId;
      return { externalAccountId: user.id, created: user.isNew };
    });

    const handler = getMarketHandler(market, "provision");

    await expect(
      handler?.({
        buyerId: "byr_a9f3",
        sku: "pro",
        orderId: "ord_123",
      }),
    ).resolves.toEqual({ externalAccountId: "usr_byr_a9f3", created: true });
  });
});

describe("Market.webhooks", () => {
  it("throws a setup-time error when no webhook secret was configured", () => {
    const market = new Market(KEY);

    expect(() => market.webhooks.handler()).toThrow(
      MISSING_WEBHOOK_SECRET_MESSAGE,
    );
  });

  it("throws when the webhook secret is blank", () => {
    const market = new Market(KEY, { webhookSecret: "   " });

    expect(() => market.webhooks.handler()).toThrow(
      MISSING_WEBHOOK_SECRET_MESSAGE,
    );
  });

  it("returns a Request to Response function when a secret was configured", () => {
    const market = new Market(KEY, { webhookSecret: SECRET });

    expect(market.webhooks.handler()).toBeTypeOf("function");
  });

  it("does not expose the webhook secret on the instance", () => {
    const market = new Market(KEY, { webhookSecret: SECRET });

    expect(JSON.stringify(market)).not.toContain(SECRET);
    expect(Object.keys(market)).not.toContain("webhookSecret");
  });

  it("keeps the webhook secret separate from the API key", () => {
    const market = new Market(KEY, { webhookSecret: SECRET });

    // The two are independent: a valid secret receiver still builds even
    // though the key and secret differ.
    expect(() => market.webhooks.handler()).not.toThrow();
  });
});
