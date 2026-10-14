import { afterEach, describe, expect, it, vi } from "vitest";

import { joinUrl, request } from "./http";
import { SDK_VERSION } from "./version";

const KEY = "test-key";
const BASE = "https://api.example.test";

/**
 * Replaces the global `fetch` and returns the spy the assertions read.
 *
 * The type argument gives `spy.mock.calls[0]` its tuple type, so a call site
 * reads the URL and the init with no assertion. The stub reads neither: it
 * answers the same way every call.
 */
function stubFetch(answer: Response | Error) {
  const spy = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
    answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** Reads the URL and the headers the stub received. */
function callOf(spy: ReturnType<typeof stubFetch>) {
  const [url, init] = spy.mock.calls[0];
  return { url, headers: new Headers(init?.headers) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("joinUrl", () => {
  it("puts one slash between the base and the path", () => {
    expect(joinUrl(BASE, "products")).toBe(`${BASE}/products`);
  });

  it("strips the leading slashes of the path", () => {
    expect(joinUrl(BASE, "//products")).toBe(`${BASE}/products`);
  });

  it("strips the trailing slashes of the base", () => {
    expect(joinUrl(`${BASE}//`, "/products")).toBe(`${BASE}/products`);
  });

  it("keeps a path segment of the base", () => {
    expect(joinUrl(`${BASE}/v1/`, "/products")).toBe(`${BASE}/v1/products`);
  });
});

describe("request", () => {
  it("sends the three headers", async () => {
    const spy = stubFetch(new Response("{}", { status: 200 }));

    await request(KEY, BASE, "/products");

    const { headers } = callOf(spy);
    expect(headers.get("Authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("User-Agent")).toBe(`metzia-sdk/${SDK_VERSION}`);
  });

  it("joins the base and the path", async () => {
    const spy = stubFetch(new Response("{}", { status: 200 }));

    await request(KEY, `${BASE}/`, "/products");

    expect(callOf(spy).url).toBe(`${BASE}/products`);
  });

  it("keeps a caller header the three do not name", async () => {
    const spy = stubFetch(new Response("{}", { status: 200 }));

    await request(KEY, BASE, "products", {
      headers: { "Idempotency-Key": "one" },
    });

    expect(callOf(spy).headers.get("Idempotency-Key")).toBe("one");
  });

  it("does not let a caller header replace the key", async () => {
    const spy = stubFetch(new Response("{}", { status: 200 }));

    await request(KEY, BASE, "products", {
      headers: { Authorization: "Bearer other-key" },
    });

    expect(callOf(spy).headers.get("Authorization")).toBe(`Bearer ${KEY}`);
  });

  it("parses a 200 JSON body", async () => {
    stubFetch(new Response(JSON.stringify({ id: "prod_1" }), { status: 200 }));

    const result = await request<{ id: string }>(KEY, BASE, "products");

    expect(result).toEqual({ ok: true, status: 200, body: { id: "prod_1" } });
  });

  it("returns a 204 as a success with no body", async () => {
    stubFetch(new Response(null, { status: 204 }));

    const result = await request(KEY, BASE, "products/prod_1");

    expect(result).toEqual({ ok: true, status: 204, body: undefined });
  });

  it("returns a 200 with an empty body as a success with no body", async () => {
    stubFetch(new Response("", { status: 200 }));

    const result = await request(KEY, BASE, "products");

    expect(result).toEqual({ ok: true, status: 200, body: undefined });
  });

  it("returns a 404 JSON body as a typed failure", async () => {
    const body = JSON.stringify({ error: "not_found" });
    stubFetch(new Response(body, { status: 404 }));

    const result = await request(KEY, BASE, "products/nope");

    expect(result).toEqual({
      ok: false,
      code: "http",
      status: 404,
      body,
      retryAfterSeconds: null,
    });
  });

  it("returns a 500 HTML body as a typed failure with the raw text", async () => {
    const html = "<html><body>Bad gateway</body></html>";
    stubFetch(new Response(html, { status: 500 }));

    const result = await request(KEY, BASE, "products");

    expect(result).toEqual({
      ok: false,
      code: "http",
      status: 500,
      body: html,
      retryAfterSeconds: null,
    });
  });

  it("returns a 200 the parser rejects as a body failure, not an http one", async () => {
    stubFetch(new Response("not json", { status: 200 }));

    const result = await request(KEY, BASE, "products");

    expect(result).toEqual({
      ok: false,
      code: "body",
      status: 200,
      body: "not json",
    });
  });

  it("returns a rejected fetch as a network failure", async () => {
    const error = new TypeError("fetch failed");
    stubFetch(error);

    const result = await request(KEY, BASE, "products");

    expect(result).toEqual({ ok: false, code: "network", error });
  });

  it("returns a 200 whose body drops after the headers as a body failure", async () => {
    const broken = new ReadableStream({
      start(controller) {
        controller.error(new TypeError("terminated"));
      },
    });
    stubFetch(new Response(broken, { status: 200 }));

    const result = await request(KEY, BASE, "products");

    // `http` never carries a 2xx, or a caller that branches on the status
    // would read this as a success.
    expect(result).toEqual({ ok: false, code: "body", status: 200, body: "" });
  });

  it("returns a body that drops after the headers as an http failure", async () => {
    const broken = new ReadableStream({
      start(controller) {
        controller.error(new TypeError("terminated"));
      },
    });
    stubFetch(new Response(broken, { status: 502 }));

    const result = await request(KEY, BASE, "products");

    expect(result).toEqual({
      ok: false,
      code: "http",
      status: 502,
      body: "",
      retryAfterSeconds: null,
    });
  });

  it("never throws on a non 2xx status", async () => {
    stubFetch(new Response("", { status: 503 }));

    await expect(request(KEY, BASE, "products")).resolves.toMatchObject({
      ok: false,
    });
  });

  it("reads the whole seconds of Retry-After", async () => {
    stubFetch(new Response("", { status: 503, headers: { "retry-after": " 10 " } }));

    const result = await request(KEY, BASE, "products");

    expect(result).toMatchObject({ retryAfterSeconds: 10 });
  });

  it("caps an absurd Retry-After at one hour", async () => {
    stubFetch(new Response("", { status: 503, headers: { "retry-after": "999999" } }));

    const result = await request(KEY, BASE, "products");

    expect(result).toMatchObject({ retryAfterSeconds: 3600 });
  });

  it.each([
    ["an empty value", ""],
    ["a zero", "0"],
    ["a negative value", "-5"],
    ["a fraction", "1.5"],
    ["a word", "soon"],
    ["an HTTP date", "Wed, 21 Oct 2026 07:28:00 GMT"],
    ["a hexadecimal value", "0x10"],
    ["an exponent", "2e1"],
    ["a signed value", "+2"],
    ["a trailing zero", "2.0"],
  ])("reads %s of Retry-After as no wait", async (_name, header) => {
    stubFetch(new Response("", { status: 503, headers: { "retry-after": header } }));

    const result = await request(KEY, BASE, "products");

    expect(result).toMatchObject({ retryAfterSeconds: null });
  });
});

describe("request timeout", () => {
  /** A fetch that answers only when its signal aborts. */
  function hangingFetch() {
    const spy = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("ends an attempt that gets no answer as a network failure", async () => {
    hangingFetch();

    const result = await request("mk_live_x", "https://api.example.test", "/v1/products", {}, 20);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("network");
  });

  it("still ends at once when the caller aborts", async () => {
    hangingFetch();
    const caller = new AbortController();

    const pending = request("mk_live_x", "https://api.example.test", "/v1/products", {
      signal: caller.signal,
    });
    caller.abort(new Error("the caller stopped"));

    const result = await pending;
    expect(!result.ok && result.code).toBe("network");
    expect(!result.ok && result.code === "network" && (result.error as Error).message).toBe(
      "the caller stopped",
    );
  });

  it("passes the request a signal even when the caller gives none", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);

    await request("mk_live_x", "https://api.example.test", "/v1/products");

    expect(spy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
