import { afterEach, describe, expect, it, vi } from "vitest";

import { MarketNetworkError, MarketRequestError, MarketRetryError, MarketValidationError } from "./errors";
import { Market } from "./market";
import { PUBLISH_PATH } from "./products";
import type { ListingInput } from "./schema";
import { DEFAULT_VOCABULARY_TTL_MS, VOCABULARY_PATH } from "./vocabulary";

const KEY = "osk_sel_TESTKEY";
const BASE = "https://api.example.test";
const LIST_URL = `${BASE}${VOCABULARY_PATH}`;
const ETAG = '"v1-abc"';

const VOCABULARY = {
  categories: [
    { slug: "crm", display_name: "CRM", parent: null },
    { slug: "crm-sales", display_name: "Sales CRM", parent: "crm" },
  ],
  integrations: [
    { slug: "slack", display_name: "Slack" },
    { slug: "github", display_name: "GitHub" },
  ],
  limit_keys: [],
};

const PUBLISHED = {
  product: { id: "prd_1", sku: "crm-pro", name: "CRM Pro", status: "draft", version: 1, syncedAt: null },
  created: true,
  pendingReview: false,
};

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
    notAFitWhen: "A one-person team that prefers to keep every customer record in a spreadsheet.",
    pricePoints: [{ amountMicros: 25_000_000, unitName: "per seat per month" }],
    ...overrides,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

type Answer = Response | Error | (() => Response);

/**
 * One fetch stub with two queues: the vocabulary reads and the publish calls.
 * A call past the end of its queue is a defect in the test.
 */
function stub(vocabulary: Answer[], publishes: Answer[] = []) {
  const reads = [...vocabulary];
  const posts = [...publishes];
  const next = (queue: Answer[], name: string): Promise<Response> => {
    const answer = queue.shift();
    if (answer === undefined) return Promise.reject(new Error(`The stub ran out of ${name} answers.`));
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(typeof answer === "function" ? answer() : answer);
  };

  const spy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>((url) =>
    String(url).endsWith(VOCABULARY_PATH) ? next(reads, "vocabulary") : next(posts, "publish"),
  );
  vi.stubGlobal("fetch", spy);

  return {
    spy,
    vocabularyCalls: () => spy.mock.calls.filter(([url]) => String(url).endsWith(VOCABULARY_PATH)),
    publishCalls: () => spy.mock.calls.filter(([url]) => String(url).endsWith(PUBLISH_PATH)),
  };
}

function market(options: { vocabularyTtlMs?: number } = {}): Market {
  return new Market(KEY, { baseUrl: BASE, ...options });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the vocabulary check in define", () => {
  it("refuses the category quantum before the publish, and names the term and the list", async () => {
    const calls = stub([json(200, VOCABULARY)]);

    const error = await market()
      .products.define(listing({ categorySlug: "quantum" }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MarketValidationError);
    const issue = (error as MarketValidationError).errors[0];
    expect(issue).toMatchObject({ field: "categorySlug", rule: "unknown_category" });
    expect(issue?.message).toContain('"quantum"');
    expect(issue?.message).toContain(LIST_URL);
    expect(calls.publishCalls()).toHaveLength(0);
  });

  it("names each unknown integration by its position", async () => {
    stub([json(200, VOCABULARY)]);

    const error = await market()
      .products.define(listing({ integrations: ["slack", "teams", "zoom"] }))
      .catch((caught: unknown) => caught);

    expect((error as MarketValidationError).errors.map((issue) => [issue.field, issue.rule])).toEqual([
      ["integrations.1", "unknown_integration"],
      ["integrations.2", "unknown_integration"],
    ]);
  });

  it("makes one vocabulary request for two define calls in one process", async () => {
    const calls = stub([json(200, VOCABULARY)], [json(201, PUBLISHED), json(200, { ...PUBLISHED, created: false })]);
    const client = market();

    await client.products.define(listing());
    await client.products.define(listing({ integrations: ["github"] }));

    expect(calls.vocabularyCalls()).toHaveLength(1);
    expect(calls.publishCalls()).toHaveLength(2);
  });

  it("shares one request between two reads that start together", async () => {
    const calls = stub([json(200, VOCABULARY)]);
    const client = market();

    const [categories, integrations] = await Promise.all([
      client.vocabulary.categories(),
      client.vocabulary.integrations(),
    ]);

    expect(categories).toHaveLength(2);
    expect(integrations).toHaveLength(2);
    expect(calls.vocabularyCalls()).toHaveLength(1);
  });

  it("refuses a term the platform marked deprecated, which the list no longer holds", async () => {
    const withoutSales = { ...VOCABULARY, categories: [VOCABULARY.categories[0]] };
    stub([json(200, withoutSales)]);

    await expect(market().products.define(listing({ categorySlug: "crm-sales" }))).rejects.toBeInstanceOf(
      MarketValidationError,
    );
  });

  it("reads the list at most once per instance, so a second instance reads its own", async () => {
    const calls = stub([json(200, VOCABULARY), json(200, VOCABULARY)]);

    await market().vocabulary.categories();
    await market().vocabulary.categories();

    expect(calls.vocabularyCalls()).toHaveLength(2);
  });
});

describe("the cache window", () => {
  it("asks again after the window with If-None-Match, and a 304 keeps the cached list", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const calls = stub([json(200, VOCABULARY, { etag: ETAG }), new Response(null, { status: 304 })]);
    const client = market();

    const first = await client.vocabulary.categories();
    vi.setSystemTime(DEFAULT_VOCABULARY_TTL_MS - 1);
    await client.vocabulary.categories();
    expect(calls.vocabularyCalls()).toHaveLength(1);

    vi.setSystemTime(DEFAULT_VOCABULARY_TTL_MS);
    const second = await client.vocabulary.categories();

    expect(calls.vocabularyCalls()).toHaveLength(2);
    expect(new Headers(calls.vocabularyCalls()[1]?.[1]?.headers).get("if-none-match")).toBe(ETAG);
    expect(second).toBe(first);

    // The 304 started the window again.
    vi.setSystemTime(DEFAULT_VOCABULARY_TTL_MS * 2 - 1);
    await client.vocabulary.categories();
    expect(calls.vocabularyCalls()).toHaveLength(2);
  });

  it("sends no If-None-Match on the first read", async () => {
    const calls = stub([json(200, VOCABULARY, { etag: ETAG })]);

    await market().vocabulary.categories();

    expect(new Headers(calls.vocabularyCalls()[0]?.[1]?.headers).has("if-none-match")).toBe(false);
  });

  it("takes the window from vocabularyTtlMs, and zero reads every time", async () => {
    const calls = stub([json(200, VOCABULARY), json(200, VOCABULARY)]);
    const client = market({ vocabularyTtlMs: 0 });

    await client.vocabulary.categories();
    await client.vocabulary.categories();

    expect(calls.vocabularyCalls()).toHaveLength(2);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses the vocabularyTtlMs %s at construction", (ttl) => {
    expect(() => market({ vocabularyTtlMs: ttl })).toThrow(/vocabularyTtlMs/);
  });
});

describe("a vocabulary the SDK cannot read", () => {
  it("throws MarketNetworkError, not MarketValidationError, when the endpoint is unreachable", async () => {
    vi.useFakeTimers();
    const outage = new TypeError("fetch failed");
    const calls = stub([outage, outage, outage, outage]);

    const pending = market()
      .products.define(listing())
      .catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(200 + 400 + 800);
    const error = await pending;

    expect(error).toBeInstanceOf(MarketNetworkError);
    expect(error).toBeInstanceOf(MarketRequestError);
    expect(error).not.toBeInstanceOf(MarketValidationError);
    expect((error as MarketNetworkError).status).toBeNull();
    expect((error as Error).message).toContain(LIST_URL);
    expect(calls.vocabularyCalls()).toHaveLength(4);
    expect(calls.publishCalls()).toHaveLength(0);
  });

  it("throws MarketNetworkError with the status for a server error", async () => {
    stub([json(503, { error: { code: "unavailable", message: "The vocabulary could not be read." } })]);

    const error = await market()
      .vocabulary.categories()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MarketNetworkError);
    expect((error as MarketNetworkError).status).toBe(503);
  });

  it("throws MarketRetryError with the wait for a rate limit", async () => {
    stub([json(429, { error: { code: "rate_limited", message: "Slow down." } }, { "retry-after": "30" })]);

    const error = await market()
      .vocabulary.categories()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MarketRetryError);
    expect((error as MarketRetryError).retryAfterSeconds).toBe(30);
  });

  it("throws MarketRequestError for a list it cannot read, and keeps no cache", async () => {
    const calls = stub([json(200, { categories: "all" }), json(200, VOCABULARY)]);
    const client = market();

    await expect(client.vocabulary.categories()).rejects.toBeInstanceOf(MarketRequestError);
    await expect(client.vocabulary.categories()).resolves.toHaveLength(2);
    expect(calls.vocabularyCalls()).toHaveLength(2);
  });
});

describe("market.vocabulary", () => {
  it("answers the lists in the SDK shape, in the order the platform sends them", async () => {
    stub([json(200, VOCABULARY)]);
    const client = market();

    await expect(client.vocabulary.categories()).resolves.toEqual([
      { slug: "crm", displayName: "CRM", parent: null },
      { slug: "crm-sales", displayName: "Sales CRM", parent: "crm" },
    ]);
    await expect(client.vocabulary.integrations()).resolves.toEqual([
      { slug: "slack", displayName: "Slack" },
      { slug: "github", displayName: "GitHub" },
    ]);
  });
});
