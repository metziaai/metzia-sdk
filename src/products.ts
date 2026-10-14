import { z } from "zod";

import {
  MarketConflictError,
  MarketRequestError,
  MarketRetryError,
  MarketValidationError,
} from "./errors";
import { listingSchema, validateListing, type ListingInput } from "./schema";
import {
  bodyWaitSeconds,
  detailOf,
  envelopeIssues,
  readEnvelope,
  RETRIES,
  sendWithRetry,
  type Answered,
  type ErrorEnvelope,
  type Send,
} from "./transport";

/**
 * The publish transport.
 *
 * The platform's publish endpoint holds the contract this module speaks.
 *
 * The call is one POST. The SDK validates the listing first, so a listing the
 * rules refuse reaches no network. The call carries an idempotency key, so a
 * retry after a network failure publishes one listing and not two.
 *
 * One `define()` sends at most 6 requests: the first attempt, 3 retries of a
 * network failure, and 2 waits for the earlier attempt of this same call. The
 * route spends one publish call of the hourly limit on every request, so the
 * ceiling stays low.
 *
 * `define()` raises an error for every refusal, and it never returns one. The
 * issue asks for raised errors, and `validateListing()` already raises one for
 * a listing this SDK refuses, so a caller reads one shape for both.
 */
export const PUBLISH_PATH = "/api/v1/products";

/**
 * How many times this module waits for the earlier attempt of one call.
 *
 * The route answers 409 with `retry-after` while a call with the key still
 * runs, and it spends one publish call of the hourly limit on every such
 * answer. Two waits cover the attempt this module itself lost to a network
 * failure, and they cost the seller little of that limit.
 */
const IN_FLIGHT_WAITS = 2;

/**
 * The idempotency key limit of the route.
 *
 * The platform owns the rule, so the number stands here a second time.
 */
const IDEMPOTENCY_KEY_LIMIT = 255;

/** A header value holds visible ASCII. `new Headers()` refuses every other byte. */
const HEADER_VALUE = /^[\x20-\x7e]+$/;

/**
 * The top level names of the listing, read from the schema.
 *
 * The route sends one code, `invalid_listing`, for the three 422 answers of
 * the publish: a bad `Idempotency-Key` header, a body that is not JSON, and a
 * listing the rules refuse. The code therefore separates none of them, and the
 * issue path does: a path of the listing starts with a name of this set. The
 * set follows the schema, so a new field needs no edit here.
 */
const LISTING_FIELDS: ReadonlySet<string> = new Set(Object.keys(listingSchema.shape));

const productSchema = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
  status: z.string(),
  version: z.number(),
  syncedAt: z.string().nullable(),
});

const publishedSchema = z.object({
  product: productSchema,
  created: z.boolean(),
  // The platform answers 202 with `pendingReview` true when the sku names a
  // listing that staff approved before. A 200 names no such key, so the
  // default reads it as a publish that stands.
  pendingReview: z.boolean().default(false),
  // Present on a 202 alone. `submittedAt` is the ISO moment the platform
  // stored the change, and `message` says what happens next.
  submittedAt: z.string().optional(),
  message: z.string().optional(),
});

/** The listing the platform holds after the publish. */
export type Product = z.infer<typeof productSchema>;

/**
 * `created` is false when the publish replaced an earlier version of the listing.
 *
 * `pendingReview` is true when the listing was live before. Staff review the
 * change first, and `product` is the live version that buyers keep seeing
 * until staff approve it. A later `define()` of the same sku replaces the
 * change that waits. `submittedAt` and `message` then name the moment the
 * platform stored the change and the next step.
 */
export type DefineResult = z.infer<typeof publishedSchema>;

export type DefineOptions = {
  /**
   * Publishes under a key the caller names.
   *
   * The platform stores the answer of the first call under the key and replays
   * that answer for ever. A later payload under the same key reads a conflict.
   * Pass a key only to name your own replay scope, such as one row of a job.
   *
   * Without this option each call carries a new key, so a second `define()`
   * for one sku publishes the new listing. The route upserts the sku, so that
   * second call is an update of the listing and not a duplicate of it.
   */
  idempotencyKey?: string;

  /**
   * Stops the publish, and every retry of it.
   *
   * The signal reaches `fetch`, and it ends a wait between two attempts at
   * once. An abort raises the reason of the signal, which is the `AbortError`
   * of the platform by default. The SDK raises no error of its own here,
   * because the caller already holds the reason it named.
   *
   * An abort stops the retries. The platform may hold the listing of a call
   * that already landed, so read it with `market.request("/api/v1/products")`
   * before you publish it again. `ProductSurface` has no list method yet.
   */
  signal?: AbortSignal;
};

export type ProductSurface = {
  define(input: ListingInput, options?: DefineOptions): Promise<DefineResult>;
};

/**
 * Builds the idempotency key of one `define()` call.
 *
 * One key names one call. Every retry of that call carries this key, so a call
 * that arrived and lost its answer replays instead of publishing twice. The
 * next call builds another key, because the platform keeps a finished key for
 * ever and a shared key would replay the stale answer.
 */
function newIdempotencyKey(): string {
  const webCrypto = globalThis.crypto;

  if (typeof webCrypto?.randomUUID !== "function") {
    // Node 20 and every browser on HTTPS hold it. A runtime without it cannot
    // build the key that makes a retry safe, so the publish stops here.
    throw new MarketRequestError(
      "The runtime holds no crypto.randomUUID, so the SDK built no idempotency key and sent no request. Run the SDK on Node 20 or later, or pass the idempotencyKey option.",
    );
  }

  return `sdk1-${webCrypto.randomUUID()}`;
}

/**
 * Checks the terms of one validated listing against the vocabulary. It throws
 * `MarketValidationError` for a term outside the list. `Market` binds it to
 * the cache of the instance.
 */
export type TermCheck = (
  listing: ReturnType<typeof validateListing>,
  signal: AbortSignal | undefined,
) => Promise<void>;

/**
 * Validates one listing, checks its terms, and publishes it.
 *
 * The shape validation runs first and throws `MarketValidationError` before
 * any network call, so a listing the rules refuse costs the seller no request.
 * The term check runs next: it reads the vocabulary at most once per cache
 * window and throws `MarketValidationError` for a category or an integration
 * outside the list, before the publish.
 */
export async function defineProduct(
  post: Send,
  input: ListingInput,
  options?: DefineOptions,
  checkTerms?: TermCheck,
): Promise<DefineResult> {
  const listing = validateListing(input);

  await checkTerms?.(listing, options?.signal);

  const idempotencyKey =
    options?.idempotencyKey === undefined
      ? newIdempotencyKey()
      : checkIdempotencyKey(options.idempotencyKey);

  const result = await send(post, JSON.stringify(toWire(listing)), idempotencyKey, options?.signal);

  return answer(result, listing.sku);
}

/**
 * Writes the listing in the form the publish API reads.
 *
 * The SDK takes a whole number as a JavaScript number, because a seller writes
 * `25_000_000`. The API reads a whole number as a string of digits, because
 * JSON carries no integer as wide as a `bigint`. The schema bounds each value at `Number.MAX_SAFE_INTEGER`, so
 * `String` writes every digit.
 */
function toWire(listing: ReturnType<typeof validateListing>) {
  return {
    ...listing,
    pricePoints: listing.pricePoints.map((point) => ({
      ...point,
      amountMicros: String(point.amountMicros),
      tierMin: point.tierMin === null ? null : String(point.tierMin),
      tierMax: point.tierMax === null ? null : String(point.tierMax),
    })),
  };
}

/**
 * Checks the key the caller named, and returns it trimmed.
 *
 * A key outside the rule is a caller defect, so it throws. Without the check
 * `new Headers()` raises an opaque `TypeError` on a non ASCII value, and the
 * route answers 422 on a long one after the call already spent the budget.
 */
function checkIdempotencyKey(key: string): string {
  const trimmed = key.trim();

  if (trimmed === "" || trimmed.length > IDEMPOTENCY_KEY_LIMIT || !HEADER_VALUE.test(trimmed)) {
    throw new MarketRequestError(
      `The idempotencyKey option was refused and no request was sent. Pass 1 to ${IDEMPOTENCY_KEY_LIMIT} visible ASCII characters.`,
    );
  }

  return trimmed;
}

/**
 * Sends the publish, and sends it again for the two answers a retry repairs.
 *
 * A network failure never delivered an answer, so the SDK sends the call again
 * up to three times. A 409 that names a wait says an earlier attempt with this
 * key still runs. The SDK waits for that answer at most twice, and only after
 * a network failure of this same call: such a 409 on the first attempt names
 * another process, which this call must not outwait. Every other HTTP answer
 * is the platform's decision and stands.
 *
 * Every attempt carries one idempotency key and one body, so a call that
 * arrived and lost its answer replays instead of publishing twice.
 */
function send(
  post: Send,
  body: string,
  idempotencyKey: string,
  signal: AbortSignal | undefined,
): Promise<Answered> {
  let waits = 0;

  return sendWithRetry(
    post,
    PUBLISH_PATH,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body,
      signal,
    },
    {
      signal,
      exhausted: (cause) =>
        new MarketRequestError(
          `The publish did not reach the platform in ${RETRIES + 1} attempts, and the outcome is unknown. Read the catalog with market.request("${PUBLISH_PATH}"), then publish the listing again if it is absent.`,
          { cause },
        ),
      waitFor: (result, networkFailures) => {
        // Only a 409 that names a wait says an attempt is still in flight. A
        // 409 without the header names a payload that conflicts, and it stands.
        const inFlightWait =
          !result.ok && result.code === "http" && result.status === 409
            ? result.retryAfterSeconds
            : null;

        if (inFlightWait === null || networkFailures === 0 || waits === IN_FLIGHT_WAITS) {
          return null;
        }

        waits += 1;
        return inFlightWait * 1000;
      },
    },
  );
}

/** Turns one answer into the published listing, or into the error that names it. */
function answer(result: Answered, sku: string): DefineResult {
  if (result.ok) {
    const parsed = publishedSchema.safeParse(result.body);
    if (parsed.success) return parsed.data;

    throw new MarketRequestError(
      `The platform accepted the publish with status ${result.status} and the SDK cannot read the answer. The listing ${sku} may stand. Read the catalog with market.request("${PUBLISH_PATH}"), and update the SDK.`,
      { status: result.status },
    );
  }

  if (result.code === "body") {
    throw new MarketRequestError(
      `The platform answered ${result.status} with a body that is not JSON. The listing ${sku} may stand. Read the catalog with market.request("${PUBLISH_PATH}").`,
      { status: result.status },
    );
  }

  const envelope = readEnvelope(result.body);
  const detail = envelope?.message ?? detailOf(result.body);

  if (result.status === 422) {
    const foreign = firstForeignField(envelope);

    if (foreign !== null) {
      throw new MarketRequestError(
        `The platform refused the publish of the listing ${sku} with status 422 and nothing was written. The refusal names ${foreign} and not a listing field. The platform said: ${detail}`,
        { status: result.status, code: envelope?.code },
      );
    }

    throw new MarketValidationError(envelopeIssues(envelope));
  }

  // Only `Retry-After` separates the call that is still in flight from the
  // payload that conflicts, so a 409 without that header is a conflict.
  if (result.status === 409) {
    if (result.retryAfterSeconds === null) {
      throw new MarketConflictError(sku, detail);
    }
    throw new MarketRetryError(result.status, result.retryAfterSeconds, detail);
  }

  if (result.status === 429 || result.status >= 500) {
    const wait = result.retryAfterSeconds ?? bodyWaitSeconds(envelope);
    throw new MarketRetryError(result.status, wait, detail);
  }

  throw new MarketRequestError(
    `The platform refused the publish of the listing ${sku} with status ${result.status} and nothing was written. The platform said: ${detail}`,
    { status: result.status, code: envelope?.code },
  );
}

/**
 * The first field of a 422 that names no listing path, or null.
 *
 * Null says every issue names the listing, so the refusal is a validation
 * failure the caller repairs in the payload. A 422 that names the header, the
 * body, or no field at all refused the request itself, and one foreign field
 * among several is enough: the caller cannot repair the listing alone.
 */
function firstForeignField(envelope: ErrorEnvelope | undefined): string | null {
  const fields = envelope?.fields ?? [];

  if (fields.length === 0) return "no field";

  const foreign = fields.find((field) => !LISTING_FIELDS.has(field.field.split(".")[0]));

  return foreign === undefined ? null : `the field ${foreign.field}`;
}

