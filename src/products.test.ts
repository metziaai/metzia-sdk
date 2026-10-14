import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  MarketConflictError,
  MarketRequestError,
  MarketRetryError,
  MarketValidationError,
} from "./errors";
import { Market } from "./market";
import { PUBLISH_PATH } from "./products";
import { VOCABULARY_PATH } from "./vocabulary";
import type { ListingInput } from "./schema";

const KEY = "osk_sel_TESTKEY";
const BASE = "https://api.example.test";

const NOT_A_FIT =
  "A one-person team that prefers to keep every customer record in a spreadsheet.";

/** The key the SDK builds: the version prefix and one UUID. */
const SDK_KEY = /^sdk1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

const PUBLISHED = {
  product: {
    id: "prd_1",
    sku: "crm-pro",
    name: "CRM Pro",
    status: "draft",
    version: 1,
    syncedAt: null,
  },
  created: true,
  pendingReview: false,
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function envelope(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): { error: Record<string, unknown> } {
  return { error: { code, message, ...extra } };
}

/** The in flight answer of the route, with the wait it names. */
function inFlight(): Response {
  return json(
    409,
    envelope("idempotency_conflict", "An earlier call with this key has not answered.", {
      retry_after_seconds: 2,
    }),
    { "retry-after": "2" },
  );
}

/**
 * Answers each call with the next item, so one test drives a retry.
 *
 * A call the list does not cover is a defect in the test, and the rejection
 * below names it instead of letting the code read an answer nobody wrote.
 */
function stubFetch(...answers: readonly (Response | Error)[]) {
  const queue = [...answers];

  const spy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() => {
    const answer = queue.shift();
    if (answer === undefined) return Promise.reject(new Error("The stub ran out of answers."));
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });

  vi.stubGlobal("fetch", withVocabulary(spy));
  return spy;
}

/**
 * The vocabulary `define()` reads before each publish, with the one category
 * the listing names. `src/vocabulary.test.ts` holds the vocabulary cases.
 */
const VOCABULARY = {
  categories: [{ slug: "crm", display_name: "CRM", parent: null }],
  integrations: [],
  limit_keys: [],
};

/**
 * Answers the vocabulary read itself and sends every other call to `spy`, so
 * a spy counts and records the publish calls alone.
 */
function withVocabulary(spy: (url: string, init?: RequestInit) => Promise<Response>) {
  return (url: string, init?: RequestInit): Promise<Response> =>
    String(url).endsWith(VOCABULARY_PATH) ? Promise.resolve(json(200, VOCABULARY)) : spy(url, init);
}

type FetchSpy = ReturnType<typeof stubFetch>;

/** The body of a publish is a JSON object, and the schema proves it. */
const sentBody = z.record(z.string(), z.unknown());

function callOf(spy: FetchSpy, index = 0) {
  const [url, init] = spy.mock.calls[index];
  return {
    url,
    method: init?.method,
    headers: new Headers(init?.headers),
    body: sentBody.parse(JSON.parse(String(init?.body))),
  };
}

function keyOf(spy: FetchSpy, index = 0): string | null {
  return callOf(spy, index).headers.get("Idempotency-Key");
}

function market(): Market {
  return new Market(KEY, { baseUrl: BASE });
}

/**
 * Runs a publish that must fail, and returns the error under its own type.
 *
 * The check and the narrowing happen here, so no test asserts a type it did
 * not prove.
 */
async function refusal<T>(
  promise: Promise<unknown>,
  type: new (...args: never[]) => T,
): Promise<T> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(type);
    if (error instanceof type) return error;
    throw error;
  }
  throw new Error("Expected the publish to fail.");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("products.define", () => {
  it("sends no request when the listing is invalid", async () => {
    const spy = stubFetch();

    await refusal(market().products.define(listing({ sku: "" })), MarketValidationError);

    expect(spy).not.toHaveBeenCalled();
  });

  it("reads a 202 as a change that waits for staff review", async () => {
    const live = { ...PUBLISHED.product, status: "published", version: 3 };
    stubFetch(
      json(202, {
        product: live,
        created: false,
        pendingReview: true,
        submittedAt: "2026-09-24T10:00:00.000Z",
        message: "The change waits for staff review.",
      }),
    );

    const result = await market().products.define(listing());

    expect(result).toEqual({
      product: live,
      created: false,
      pendingReview: true,
      submittedAt: "2026-09-24T10:00:00.000Z",
      message: "The change waits for staff review.",
    });
  });

  it("reads a 200 with no review key as a publish that stands", async () => {
    stubFetch(json(200, { product: PUBLISHED.product, created: PUBLISHED.created }));

    const result = await market().products.define(listing());

    expect(result.pendingReview).toBe(false);
  });

  it("posts the validated listing to the catalog route", async () => {
    const spy = stubFetch(json(200, PUBLISHED));

    const result = await market().products.define(listing());

    const call = callOf(spy);
    expect(call.url).toBe(`${BASE}${PUBLISH_PATH}`);
    expect(call.method).toBe("POST");
    expect(call.headers.get("Content-Type")).toBe("application/json");
    expect(call.headers.get("Authorization")).toBe(`Bearer ${KEY}`);
    // The schema fills the optional fields, so the server reads one shape.
    expect(call.body).toMatchObject({ sku: "crm-pro", description: null });
    expect(result).toEqual(PUBLISHED);
  });

  /**
   * The publish API reads a whole number as a string of digits, and refuses a
   * JSON number, so a listing sent as a number could not publish.
   */
  it("writes each whole number as a string of digits on the wire", async () => {
    const spy = stubFetch(json(200, PUBLISHED));

    await market().products.define({
      ...listing(),
      pricingModel: "tiered",
      pricePoints: [
        { amountMicros: 25_000_000, unitName: "per seat per month", tierMin: 1, tierMax: 10 },
        { amountMicros: 20_000_000, unitName: "per seat per month", tierMin: 10 },
      ],
    });

    expect(callOf(spy).body.pricePoints).toEqual([
      expect.objectContaining({ amountMicros: "25000000", tierMin: "1", tierMax: "10" }),
      expect.objectContaining({ amountMicros: "20000000", tierMin: "10", tierMax: null }),
    ]);
  });

  it("sends another idempotency key for a second call with the same sku", async () => {
    const spy = stubFetch(json(200, PUBLISHED), json(200, PUBLISHED));
    const client = market();

    await client.products.define(listing());
    await client.products.define(listing());

    // One key names one call. A shared key would replay the first answer and
    // the second publish would never reach the catalog.
    expect(keyOf(spy, 0)).toMatch(SDK_KEY);
    expect(keyOf(spy, 1)).toMatch(SDK_KEY);
    expect(keyOf(spy, 1)).not.toBe(keyOf(spy, 0));
  });

  it("sends one idempotency key for every retry of one call", async () => {
    vi.useFakeTimers();
    const dropped = new TypeError("fetch failed");
    const spy = stubFetch(dropped, dropped, json(200, PUBLISHED));

    const publish = market().products.define(listing());
    await vi.advanceTimersByTimeAsync(200 + 400);

    await expect(publish).resolves.toEqual(PUBLISHED);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(keyOf(spy, 0)).toMatch(SDK_KEY);
    expect(keyOf(spy, 1)).toBe(keyOf(spy, 0));
    expect(keyOf(spy, 2)).toBe(keyOf(spy, 0));
  });

  it("raises the conflict error when the key already names another payload", async () => {
    const spy = stubFetch(
      json(
        409,
        envelope("idempotency_conflict", "This idempotency key already names a different payload."),
      ),
    );

    const error = await refusal(
      market().products.define(listing(), { idempotencyKey: "seller-key-1" }),
      MarketConflictError,
    );

    expect(error.sku).toBe("crm-pro");
    expect(error.message).toContain("crm-pro");
    expect(error.message).toContain("different payload");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("keeps the idempotency key out of the conflict error", async () => {
    stubFetch(json(409, envelope("idempotency_conflict", "Refused.")));

    const error = await refusal(
      market().products.define(listing(), { idempotencyKey: "seller-key-1" }),
      MarketConflictError,
    );

    // `console.error(error)` prints every own property, so the key must be
    // none of them.
    expect(Object.values(error)).not.toContain("seller-key-1");
    expect(JSON.stringify(error)).not.toContain("seller-key-1");
    expect(error.message).not.toContain("seller-key-1");
  });

  it.each([
    ["no Retry-After", {}],
    ["a zero Retry-After", { "retry-after": "0" }],
    ["a negative Retry-After", { "retry-after": "-2" }],
    ["a word in Retry-After", { "retry-after": "soon" }],
    ["an HTTP date in Retry-After", { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }],
  ])("reads a 409 with %s as a conflict", async (_name, headers) => {
    const spy = stubFetch(json(409, envelope("idempotency_conflict", "Refused."), headers));

    await refusal(market().products.define(listing()), MarketConflictError);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("waits for no call in flight on the first attempt", async () => {
    const spy = stubFetch(inFlight());

    const error = await refusal(market().products.define(listing()), MarketRetryError);

    // This call sent nothing yet, so another process holds the key. A wait
    // here would spend the publish limit on a call this one cannot repair.
    expect(error.status).toBe(409);
    expect(error.retryAfterSeconds).toBe(2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("waits for the attempt it lost to a network failure, then publishes", async () => {
    vi.useFakeTimers();
    const spy = stubFetch(new TypeError("fetch failed"), inFlight(), json(200, PUBLISHED));

    const publish = market().products.define(listing());
    await vi.advanceTimersByTimeAsync(200 + 2000);

    await expect(publish).resolves.toEqual(PUBLISHED);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(keyOf(spy, 2)).toBe(keyOf(spy, 0));
  });

  it("waits for the call in flight at most twice", async () => {
    vi.useFakeTimers();
    const spy = stubFetch(new TypeError("fetch failed"), inFlight(), inFlight(), inFlight());

    const publish = refusal(market().products.define(listing()), MarketRetryError);
    await vi.advanceTimersByTimeAsync(200 + 2000 + 2000);
    const error = await publish;

    expect(error.status).toBe(409);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("sends at most six requests for one publish", async () => {
    vi.useFakeTimers();
    const dropped = new TypeError("fetch failed");
    const spy = stubFetch(dropped, dropped, dropped, inFlight(), inFlight(), inFlight());

    const publish = refusal(market().products.define(listing()), MarketRetryError);
    await vi.advanceTimersByTimeAsync(200 + 400 + 800 + 2000 + 2000);
    await publish;

    // One attempt, three network retries, and two waits.
    expect(spy).toHaveBeenCalledTimes(6);
  });

  it("stops the publish when the caller aborts", async () => {
    const controller = new AbortController();
    const spy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() => {
      controller.abort();
      return Promise.reject(new TypeError("fetch failed"));
    });
    vi.stubGlobal("fetch", withVocabulary(spy));

    const error = await refusal(
      market().products.define(listing(), { signal: controller.signal }),
      DOMException,
    );

    expect(error.name).toBe("AbortError");
    // The abort ends the wait between the attempts, so no timer runs out.
    expect(spy).toHaveBeenCalledTimes(1);
    // The request carries a signal joined to the caller's and to the attempt
    // timeout, so it is not the caller's own object. It aborts with it.
    expect(spy.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("sends no request for a signal that is already aborted", async () => {
    const spy = stubFetch(json(200, PUBLISHED));

    const error = await refusal(
      market().products.define(listing(), { signal: AbortSignal.abort() }),
      DOMException,
    );

    expect(error.name).toBe("AbortError");
    expect(spy).not.toHaveBeenCalled();
  });

  it("puts a server field error in the validation error", async () => {
    stubFetch(
      json(
        422,
        envelope("invalid_listing", "The listing was refused and nothing was written.", {
          fields: [
            {
              field: "pricePoints.0.amountMicros",
              code: "max",
              message: "A price point holds at most 1,000,000,000,000 micro USD.",
            },
          ],
        }),
      ),
    );

    const error = await refusal(market().products.define(listing()), MarketValidationError);

    expect(error.errors).toEqual([
      {
        field: "pricePoints.0.amountMicros",
        rule: "max",
        message: "A price point holds at most 1,000,000,000,000 micro USD.",
      },
    ]);
  });

  it("reads a 422 about the idempotency header as a request error", async () => {
    stubFetch(
      json(
        422,
        envelope("invalid_listing", "The idempotency key was refused and nothing was written.", {
          fields: [
            {
              field: "Idempotency-Key",
              code: "invalid_value",
              message: "An idempotency key holds 1 to 255 characters.",
            },
          ],
        }),
      ),
    );

    const error = await refusal(
      market().products.define(listing(), { idempotencyKey: "seller-key-1" }),
      MarketRequestError,
    );

    expect(error.status).toBe(422);
    expect(error.code).toBe("invalid_listing");
    expect(error.message).toContain("Idempotency-Key");
  });

  it("reads a 422 about the body as a request error", async () => {
    stubFetch(
      json(
        422,
        envelope("invalid_listing", "The body is not JSON.", {
          fields: [
            {
              field: "body",
              code: "invalid_value",
              message: "Send the listing as a JSON object.",
            },
          ],
        }),
      ),
    );

    const error = await refusal(market().products.define(listing()), MarketRequestError);

    expect(error.status).toBe(422);
    expect(error.message).toContain("body");
  });

  it("names the first foreign field of a mixed 422", async () => {
    stubFetch(
      json(
        422,
        envelope("invalid_listing", "The publish was refused.", {
          fields: [
            { field: "sku", code: "invalid_value", message: "A sku holds a slug." },
            {
              field: "Idempotency-Key",
              code: "invalid_value",
              message: "An idempotency key holds 1 to 255 characters.",
            },
          ],
        }),
      ),
    );

    const error = await refusal(market().products.define(listing()), MarketRequestError);

    // The caller cannot repair the header inside the listing, so the message
    // names the header and not the first entry.
    expect(error.message).toContain("Idempotency-Key");
  });

  it("reads a nested listing path as a listing field", async () => {
    stubFetch(
      json(
        422,
        envelope("invalid_listing", "The publish was refused.", {
          fields: [
            { field: "limits.seats", code: "invalid_value", message: "A limit holds an integer." },
          ],
        }),
      ),
    );

    const error = await refusal(market().products.define(listing()), MarketValidationError);

    expect(error.errors[0].field).toBe("limits.seats");
  });

  it("reads a 422 that names no field as a request error", async () => {
    stubFetch(json(422, envelope("invalid_listing", "The listing was refused.")));

    const error = await refusal(market().products.define(listing()), MarketRequestError);

    expect(error.message).toContain("no field");
  });

  it("names the wait time of a rate limit and sends the call once", async () => {
    const spy = stubFetch(
      json(429, envelope("rate_limited", "This key has spent its publish budget."), {
        "retry-after": "45",
      }),
    );

    const error = await refusal(market().products.define(listing()), MarketRetryError);

    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(45);
    expect(error.message).toContain("45 seconds");
    // The limiter refuses the call before the write, so this one is certain.
    expect(error.message).toContain("nothing was written");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a 503", 503, "unavailable"],
    ["a 409 in flight", 409, "idempotency_conflict"],
  ])("states an unknown outcome for %s", async (_name, status, code) => {
    stubFetch(json(status, envelope(code, "The platform is busy."), { "retry-after": "2" }));

    const error = await refusal(market().products.define(listing()), MarketRetryError);

    expect(error.message).toContain("the outcome of the call is unknown");
    expect(error.message).not.toContain("nothing was written");
  });

  it("states an unknown outcome for a network failure that outlives the retries", async () => {
    vi.useFakeTimers();
    const dropped = new TypeError("fetch failed");
    stubFetch(dropped, dropped, dropped, dropped);

    const publish = refusal(market().products.define(listing()), MarketRequestError);
    await vi.advanceTimersByTimeAsync(200 + 400 + 800);
    const error = await publish;

    // A dropped socket can carry a request that the platform already read.
    expect(error.message).toContain("the outcome is unknown");
  });

  it("caps an absurd wait time", async () => {
    stubFetch(
      json(503, envelope("unavailable", "The platform cannot reach the catalog."), {
        "retry-after": "86400000",
      }),
    );

    const error = await refusal(market().products.define(listing()), MarketRetryError);

    expect(error.retryAfterSeconds).toBe(3600);
  });

  it("does not retry a refused listing", async () => {
    const spy = stubFetch(json(422, envelope("invalid_listing", "The listing was refused.")));

    await refusal(market().products.define(listing()), MarketRequestError);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("retries a network failure under the same key and publishes once it lands", async () => {
    vi.useFakeTimers();
    const dropped = new TypeError("fetch failed");
    const spy = stubFetch(dropped, dropped, dropped, json(200, PUBLISHED));

    const publish = market().products.define(listing(), { idempotencyKey: "seller-key-1" });

    await vi.advanceTimersByTimeAsync(200 + 400 + 800);

    await expect(publish).resolves.toEqual(PUBLISHED);
    expect(spy).toHaveBeenCalledTimes(4);
    for (let call = 0; call < 4; call += 1) {
      expect(keyOf(spy, call)).toBe("seller-key-1");
    }
  });

  it("reports a network failure that outlives the three retries", async () => {
    vi.useFakeTimers();
    const dropped = new TypeError("fetch failed");
    const spy = stubFetch(dropped, dropped, dropped, dropped);

    const publish = refusal(
      market().products.define(listing(), { idempotencyKey: "seller-key-1" }),
      MarketRequestError,
    );

    await vi.advanceTimersByTimeAsync(200 + 400 + 800);
    const error = await publish;

    expect(error.status).toBeNull();
    expect(error.message).toContain("4 attempts");
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("refuses a caller idempotency key the route would reject", async () => {
    const spy = stubFetch();

    await refusal(
      market().products.define(listing(), { idempotencyKey: "x".repeat(256) }),
      MarketRequestError,
    );

    expect(spy).not.toHaveBeenCalled();
  });

  it("reports a success body the SDK cannot read", async () => {
    stubFetch(json(200, { product: { id: "prd_1" } }));

    const error = await refusal(market().products.define(listing()), MarketRequestError);

    expect(error.status).toBe(200);
  });
});
