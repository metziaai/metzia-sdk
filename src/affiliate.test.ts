import { afterEach, describe, expect, it, vi } from "vitest";

import { AFFILIATE_PATH } from "./affiliate";
import { ATTRIBUTION_WINDOW_MAX_DAYS } from "./catalog-fields";
import { MarketRequestError, MarketRetryError, MarketValidationError } from "./errors";
import { Market } from "./market";

const KEY = "osk_sel_TESTKEY";
const BASE = "https://api.example.test";
const PROGRAM_ID = "11111111-2222-3333-4444-555555555555";
const TEMPLATE = "https://impact.test/click?subId1={SUBID}";

const TERMS = {
  programId: "net-42",
  rate: 2500,
  term: "twelve_months",
  linkTemplate: TEMPLATE,
} as const;

const REGISTERED = {
  program: { id: PROGRAM_ID, networkProgramId: "net-42", changed: true, status: "applied", approvalRequired: true },
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

  vi.stubGlobal("fetch", spy);
  return spy;
}

function market(): Market {
  return new Market(KEY, { baseUrl: BASE });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("register", () => {
  it("returns the program id for a whole rate and a valid template", async () => {
    const spy = stubFetch(json(201, REGISTERED));

    const result = await market().affiliate.register(TERMS);

    expect(result.programId).toBe(PROGRAM_ID);
    expect(result.changed).toBe(true);
    expect(result.approvalRequired).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`${BASE}${AFFILIATE_PATH}`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(TERMS);
  });

  it("sends the attribution window when the seller states one", async () => {
    const spy = stubFetch(json(201, REGISTERED));

    await market().affiliate.register({ ...TERMS, attributionWindowDays: 7 });

    expect(JSON.parse(String(spy.mock.calls[0][1]?.body)).attributionWindowDays).toBe(7);
  });

  it("throws and names attributionWindowDays for a window over the cap", async () => {
    const spy = stubFetch();

    const failure = await market()
      .affiliate.register({ ...TERMS, attributionWindowDays: ATTRIBUTION_WINDOW_MAX_DAYS + 1 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MarketValidationError);
    expect((failure as MarketValidationError).errors[0].field).toBe("attributionWindowDays");
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws and names term for a term outside the union", async () => {
    const spy = stubFetch();

    const failure = await market()
      // A JavaScript caller reaches this method with any string, so the runtime
      // rule and not the type is what refuses the word.
      .affiliate.register({ ...TERMS, term: "forever" } as never)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MarketValidationError);
    expect((failure as MarketValidationError).errors.map((issue) => issue.field)).toContain("term");
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws and names linkTemplate for a template with no placeholder", async () => {
    const spy = stubFetch();

    const failure = await market()
      .affiliate.register({ ...TERMS, linkTemplate: "https://impact.test/click" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MarketValidationError);
    expect((failure as MarketValidationError).errors[0].field).toBe("linkTemplate");
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts the lower case placeholder", async () => {
    stubFetch(json(201, REGISTERED));

    const result = await market().affiliate.register({
      ...TERMS,
      linkTemplate: "https://impact.test/click?subId1={subid}",
    });

    expect(result.programId).toBe(PROGRAM_ID);
  });

  it("throws and names rate for a fractional rate", async () => {
    const spy = stubFetch();

    const failure = await market()
      .affiliate.register({ ...TERMS, rate: 0.25 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MarketValidationError);
    expect((failure as MarketValidationError).errors[0].field).toBe("rate");
    expect(spy).not.toHaveBeenCalled();
  });

  it("answers changed false when the platform wrote nothing", async () => {
    stubFetch(
      json(200, {
        program: { id: PROGRAM_ID, networkProgramId: "net-42", changed: false, status: "approved", approvalRequired: false },
      }),
    );

    const result = await market().affiliate.register(TERMS);

    expect(result).toEqual({
      programId: PROGRAM_ID,
      networkProgramId: "net-42",
      changed: false,
      status: "approved",
      approvalRequired: false,
    });
  });

  it("maps a 422 to MarketValidationError with the platform field names", async () => {
    stubFetch(
      json(
        422,
        envelope("invalid_program", "Correct the fields.", {
          fields: [{ field: "rate", code: "too_big", message: "The rate is above 10000." }],
        }),
      ),
    );

    const failure = await market()
      .affiliate.register(TERMS)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MarketValidationError);
    expect((failure as MarketValidationError).errors).toEqual([
      { field: "rate", rule: "too_big", message: "The rate is above 10000." },
    ]);
  });

  it("maps a 401 to MarketRequestError", async () => {
    stubFetch(json(401, envelope("unauthenticated", "Send a seller API key.")));

    const failure = await market()
      .affiliate.register(TERMS)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MarketRequestError);
    expect((failure as MarketRequestError).status).toBe(401);
    expect((failure as MarketRequestError).code).toBe("unauthenticated");
  });

  it("maps a 403 for a missing scope to MarketRequestError", async () => {
    stubFetch(
      json(403, envelope("forbidden", "This key does not hold the scope affiliate_program:write.")),
    );

    const failure = await market()
      .affiliate.register(TERMS)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MarketRequestError);
    expect((failure as MarketRequestError).status).toBe(403);
  });

  it("maps a retryable 409 conflict to MarketRetryError", async () => {
    stubFetch(json(409, envelope("conflict", "The program changed while this call ran.")));

    const failure = await market()
      .affiliate.register(TERMS)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MarketRetryError);
    expect((failure as MarketRetryError).status).toBe(409);
  });

  it("maps a 409 the caller cannot retry to MarketRequestError", async () => {
    stubFetch(json(409, envelope("program_suspended", "Staff suspended this program.")));

    const failure = await market()
      .affiliate.register(TERMS)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MarketRequestError);
    expect((failure as MarketRequestError).status).toBe(409);
  });

  it("maps a 429 to MarketRetryError with the wait", async () => {
    stubFetch(json(429, envelope("rate_limited", "Wait."), { "retry-after": "120" }));

    const failure = await market()
      .affiliate.register(TERMS)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MarketRetryError);
    expect((failure as MarketRetryError).retryAfterSeconds).toBe(120);
  });

  it("maps a 503 to MarketRetryError", async () => {
    stubFetch(json(503, envelope("unavailable", "Try again."), { "retry-after": "10" }));

    const failure = await market()
      .affiliate.register(TERMS)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MarketRetryError);
    expect((failure as MarketRetryError).status).toBe(503);
  });

  it("sends the call again after a network failure and returns the answer", async () => {
    vi.useFakeTimers();
    const spy = stubFetch(new Error("connection reset"), json(201, REGISTERED));

    const pending = market().affiliate.register(TERMS);
    await vi.runAllTimersAsync();

    expect((await pending).programId).toBe(PROGRAM_ID);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("gives up after four attempts and names the read that settles it", async () => {
    vi.useFakeTimers();
    const failure = new Error("connection reset");
    const spy = stubFetch(failure, failure, failure, failure);

    const pending = market()
      .affiliate.register(TERMS)
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    const result = await pending;
    expect(result).toBeInstanceOf(MarketRequestError);
    expect((result as MarketRequestError).message).toContain(AFFILIATE_PATH);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("raises MarketRequestError when the answer does not parse", async () => {
    stubFetch(json(201, { program: { id: PROGRAM_ID } }));

    const failure = await market()
      .affiliate.register(TERMS)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MarketRequestError);
  });
});

describe("get", () => {
  it("returns the rate and the term of the calling seller", async () => {
    const spy = stubFetch(
      json(200, {
        program: {
          id: PROGRAM_ID,
          networkProgramId: "net-42",
          rate: 2500,
          term: "twelve_months",
          linkTemplate: TEMPLATE,
          confirmedAt: "2026-09-10T00:00:00.000Z",
          status: "approved",
        },
      }),
    );

    const program = await market().affiliate.get();

    expect(program).toEqual({
      programId: PROGRAM_ID,
      networkProgramId: "net-42",
      rate: 2500,
      term: "twelve_months",
      linkTemplate: TEMPLATE,
      confirmedAt: "2026-09-10T00:00:00.000Z",
      status: "approved",
    });
    expect(spy.mock.calls[0][1]?.method).toBe("GET");
  });

  it("returns null when the seller holds no program", async () => {
    stubFetch(json(200, { program: null }));

    expect(await market().affiliate.get()).toBeNull();
  });

  it("returns a null rate and the term other", async () => {
    stubFetch(
      json(200, {
        program: {
          id: PROGRAM_ID,
          networkProgramId: "net-42",
          rate: null,
          term: "other",
          linkTemplate: TEMPLATE,
          confirmedAt: null,
          status: "applied",
        },
      }),
    );

    const program = await market().affiliate.get();

    expect(program?.rate).toBeNull();
    expect(program?.term).toBe("other");
  });

  it("maps a 403 for a missing read scope to MarketRequestError", async () => {
    stubFetch(json(403, envelope("forbidden", "This key does not hold the scope.")));

    const failure = await market()
      .affiliate.get()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MarketRequestError);
    expect((failure as MarketRequestError).status).toBe(403);
  });
});

describe("disable", () => {
  it("ends the program", async () => {
    const spy = stubFetch(json(200, { program: { id: PROGRAM_ID, changed: true } }));

    expect(await market().affiliate.disable()).toEqual({
      programId: PROGRAM_ID,
      changed: true,
    });
    expect(spy.mock.calls[0][1]?.method).toBe("DELETE");
  });

  it("answers changed false on a second call", async () => {
    stubFetch(
      json(200, { program: { id: PROGRAM_ID, changed: true } }),
      json(200, { program: { id: null, changed: false } }),
    );

    const surface = market().affiliate;

    expect((await surface.disable()).changed).toBe(true);
    expect(await surface.disable()).toEqual({ programId: null, changed: false });
  });

  it("raises MarketRequestError on a body that is not JSON", async () => {
    stubFetch(new Response("<html>gateway</html>", { status: 502 }));

    const failure = await market()
      .affiliate.disable()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MarketRetryError);
  });
});
