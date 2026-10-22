import { SDK_VERSION } from "./version";

/**
 * The answer to one API call.
 *
 * A non 2xx status is an expected answer from a live API, not a defect, so it
 * arrives as a value. The caller reads `ok` first, then `code`.
 */
export type RequestResult<T> =
  | {
      ok: true;
      status: number;
      body: T;
      /**
       * The `ETag` of the answer, when it carries one. The vocabulary read
       * sends it back in `If-None-Match`, so an unchanged list costs no body.
       */
      etag?: string;
    }
  | { ok: false; code: "network"; error: unknown }
  | {
      ok: false;
      code: "http";
      status: number;
      body: string;
      /**
       * The `Retry-After` seconds of the answer, or null.
       *
       * The response object does not outlive this function, so a caller that
       * must wait the named time cannot read the header anywhere else. Only
       * the delta seconds form is read. The API sends that form, and a caller
       * that reads a date here would need a clock the SDK does not own.
       */
      retryAfterSeconds: number | null;
    }
  | { ok: false; code: "body"; status: number; body: string };

/**
 * Joins the base URL and the path with exactly one slash.
 *
 * Both sides arrive from a caller, so both shapes appear: a base with a
 * trailing slash and a path with a leading one.
 */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * The longest wait this SDK reports, in seconds.
 *
 * The platform names at most one hour, because it holds an idempotency claim
 * for that long. A larger number comes from a broken proxy, and a caller
 * that waits on it stops for a day.
 */
const RETRY_AFTER_CAP_SECONDS = 3600;

/**
 * Reads the whole seconds of `Retry-After`.
 *
 * It accepts a run of digits, and `Number()` alone does not: that function
 * reads `0x10`, `2e1`, `+2`, and `2.0` as numbers, and the header rules name
 * none of them. An absent, empty, zero, negative, non numeric, or HTTP date
 * value gives null. A caller must not wait on a number that names no wait.
 */
function retryAfterSeconds(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (header === null) return null;

  const digits = header.trim();
  if (!/^[0-9]+$/.test(digits)) return null;

  const seconds = Number(digits);
  if (!Number.isInteger(seconds) || seconds <= 0) return null;

  return Math.min(seconds, RETRY_AFTER_CAP_SECONDS);
}

/**
 * The longest one attempt may take, from the request to the last byte of the
 * body. A request still open after it ends as a `network` failure, which the
 * retry loop in `transport.ts` sends again under the same rules as a dropped
 * socket. Without it one unanswered call held the seller's process for as
 * long as the socket stayed open.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Calls the API and returns a typed result, and gives up on an attempt after
 * `REQUEST_TIMEOUT_MS`.
 *
 * The caller's own `signal` still ends the call at once. The timeout is joined
 * to it by hand rather than with `AbortSignal.any`, which Node 20.0 to 20.2
 * lack, and `package.json` promises Node 20.
 */
export async function request<T>(
  key: string,
  baseUrl: string,
  path: string,
  init?: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<RequestResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`the request took longer than ${timeoutMs} ms`));
  }, timeoutMs);

  const caller = init?.signal ?? undefined;
  const forward = (): void => controller.abort(caller?.reason);
  if (caller?.aborted) forward();
  else caller?.addEventListener("abort", forward, { once: true });

  try {
    return await requestOnce<T>(key, baseUrl, path, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", forward);
  }
}

/**
 * Sends one attempt and returns a typed result.
 *
 * The function never throws on a non 2xx status. It never throws on a body the
 * parser rejects. A live API answers both ways every day.
 *
 * It writes no log line. The seller's process owns the log. A library that
 * prints puts a platform key one mistake away from a log file.
 *
 * A malformed `init` is a caller defect and throws. An invalid header name is
 * the common case, and `new Headers()` raises it before the request starts.
 *
 * The function checks no content type and caps no body size. The caller names
 * the path, the platform owns the API, and both run inside the seller's own
 * process. A hostile or unbounded body is not a threat this layer defends
 * against, and a cap here would truncate the text a reader needs.
 *
 * There is no retry here. A retry is only safe when the call carries the key
 * that makes it safe, so the caller owns it. `products.ts` retries a network
 * failure under one idempotency key.
 */
async function requestOnce<T>(
  key: string,
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<RequestResult<T>> {
  // A caller header must not overwrite the three below, so these are set last.
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${key}`);
  headers.set("Accept", "application/json");
  headers.set("User-Agent", `metzia-sdk/${SDK_VERSION}`);

  let response: Response;
  try {
    response = await fetch(joinUrl(baseUrl, path), { ...init, headers });
  } catch (error) {
    // The request never completed: DNS, TLS, a dropped socket, or an abort.
    return { ok: false, code: "network", error };
  }

  const status = response.status;

  let text: string;
  try {
    // The body is read as text first. A gateway answers a 500 with HTML, and
    // `response.json()` would throw on it and lose the text the reader needs.
    text = await response.text();
  } catch {
    // The headers arrived and the body did not. The status is real, so this
    // is an answer, not a network failure. The body is empty because the
    // bytes never landed. A 2xx here is a body failure, for the reason the
    // parse below states: `http` never carries a 2xx status.
    if (status >= 200 && status < 300) {
      return { ok: false, code: "body", status, body: "" };
    }
    return {
      ok: false,
      code: "http",
      status,
      body: "",
      retryAfterSeconds: retryAfterSeconds(response),
    };
  }

  if (status < 200 || status >= 300) {
    return {
      ok: false,
      code: "http",
      status,
      body: text,
      retryAfterSeconds: retryAfterSeconds(response),
    };
  }

  const etag = response.headers.get("etag") ?? undefined;
  const tag = etag === undefined ? {} : { etag };

  if (text === "") {
    // A 204, or a 200 with no content. An empty string is not JSON, so the
    // parse below would report a readable answer as a failure. See the note
    // on `T` under it: this return asserts the same unverified claim.
    return { ok: true, status, body: undefined as T, ...tag };
  }

  // `T` is the caller's claim about the shape of the body. The SDK validates
  // nothing, here or in the empty case above, so a wrong key reads as
  // `undefined`. A typed method with a schema is the way to check an answer.
  try {
    return { ok: true, status, body: JSON.parse(text) as T, ...tag };
  } catch {
    // A 2xx the caller cannot read is still a failed call. It has its own
    // code, because a caller that branches on `http` and the status would
    // read a 200 as a success it can act on.
    return { ok: false, code: "body", status, body: text };
  }
}
