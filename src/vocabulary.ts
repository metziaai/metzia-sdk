import { z } from "zod";

import {
  MarketNetworkError,
  MarketRequestError,
  MarketRetryError,
  MarketValidationError,
  type MarketValidationIssue,
} from "./errors";
import { joinUrl } from "./http";
import { bodyWaitSeconds, detailOf, readEnvelope, RETRIES, sendWithRetry, type Send } from "./transport";

/**
 * The platform vocabulary: the categories and integrations a listing may name.
 *
 * The platform serves the list, and it holds only terms a new
 * listing may use, so a term the platform marked deprecated is absent. The SDK
 * reads the list before a publish and refuses a listing that names a term
 * outside it, with a message that names the term and the list's address. Free
 * text tagging would let a seller tag itself with everything, and the platform
 * would refuse the term only after the publish call.
 *
 * ## One read per instance, and a cache
 *
 * One `Market` holds one cache. The first read fetches the list, and every
 * read inside `vocabularyTtlMs` answers from memory, so two `define()` calls
 * make one request. Two reads that start together share one request, and the
 * signal of the first one governs it. After the
 * time to live, the next read sends `If-None-Match` with the `ETag` it holds,
 * and a `304` keeps the cached list. A term the platform added a moment ago can
 * therefore fail a `define()` until the cache expires. The default is one hour,
 * a proposal the catalog owner confirms.
 *
 * ## The failure paths
 *
 * | Failure | The caller reads | Is a retry safe |
 * |---|---|---|
 * | Every attempt failed on the network | `MarketNetworkError` with a null status | Yes. Nothing was written. |
 * | The endpoint answered a server error | `MarketNetworkError` with the status | Yes, later |
 * | The endpoint answered 429 | `MarketRetryError` with the wait it names | Yes, after the wait |
 * | Another refusal, or a body the SDK cannot read | `MarketRequestError` | No. Update the SDK or read the message. |
 * | A listing names a term outside the list | `MarketValidationError`, one issue per term, before any publish | Yes, with a term from the list |
 */

/** The path of the vocabulary list on the platform. */
export const VOCABULARY_PATH = "/api/vocabulary";

/** One hour, in milliseconds. A proposal the catalog owner confirms. */
export const DEFAULT_VOCABULARY_TTL_MS = 60 * 60 * 1000;

/** One integration of the vocabulary. */
export type VocabularyTerm = {
  readonly slug: string;
  readonly displayName: string;
};

/** One category of the vocabulary. `parent` is the slug of the parent category, or null. */
export type VocabularyCategory = VocabularyTerm & {
  readonly parent: string | null;
};

/** The read surface a `Market` exposes as `market.vocabulary`. */
export type VocabularySurface = {
  /** Every category a new listing may name, in the order the platform lists them. */
  categories(options?: { readonly signal?: AbortSignal }): Promise<readonly VocabularyCategory[]>;
  /** Every integration a new listing may name, in the order the platform lists them. */
  integrations(options?: { readonly signal?: AbortSignal }): Promise<readonly VocabularyTerm[]>;
};

type Lists = {
  readonly categories: readonly VocabularyCategory[];
  readonly integrations: readonly VocabularyTerm[];
};

const wireSchema = z.object({
  categories: z.array(z.object({ slug: z.string(), display_name: z.string(), parent: z.string().nullable() })),
  integrations: z.array(z.object({ slug: z.string(), display_name: z.string() })),
});

function toLists(body: z.infer<typeof wireSchema>): Lists {
  return {
    categories: Object.freeze(
      body.categories.map((row) => Object.freeze({ slug: row.slug, displayName: row.display_name, parent: row.parent })),
    ),
    integrations: Object.freeze(
      body.integrations.map((row) => Object.freeze({ slug: row.slug, displayName: row.display_name })),
    ),
  };
}

/**
 * The vocabulary cache of one `Market`.
 *
 * `now` is the clock, and a test passes its own. The cache never holds the
 * platform key: `send` is the call `Market` binds.
 */
export class VocabularyCache {
  readonly #send: Send;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #url: string;
  #entry: { readonly lists: Lists; readonly etag: string | undefined; readAt: number } | undefined;
  #inFlight: Promise<Lists> | undefined;

  constructor(send: Send, baseUrl: string, ttlMs: number, now: () => number = () => Date.now()) {
    this.#send = send;
    this.#ttlMs = ttlMs;
    this.#now = now;
    this.#url = joinUrl(baseUrl, VOCABULARY_PATH);
  }

  /** The address of the list, which every refusal names. */
  get url(): string {
    return this.#url;
  }

  /** The two lists, from memory inside the time to live, else from the platform. */
  read(signal?: AbortSignal): Promise<Lists> {
    const entry = this.#entry;
    if (entry !== undefined && this.#now() - entry.readAt < this.#ttlMs) return Promise.resolve(entry.lists);

    this.#inFlight ??= this.#fetch(signal).finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #fetch(signal: AbortSignal | undefined): Promise<Lists> {
    const cached = this.#entry;
    const headers: Record<string, string> = cached?.etag === undefined ? {} : { "If-None-Match": cached.etag };

    const result = await sendWithRetry(
      this.#send,
      VOCABULARY_PATH,
      { method: "GET", headers, signal },
      {
        signal,
        exhausted: (cause) =>
          new MarketNetworkError(
            `The SDK could not read the vocabulary at ${this.#url} in ${RETRIES + 1} attempts, so it checked no term and published nothing. Send the call again later.`,
            { cause },
          ),
      },
    );

    // Not modified: the cached list stands, and its clock starts again.
    if (!result.ok && result.code === "http" && result.status === 304 && cached !== undefined) {
      cached.readAt = this.#now();
      return cached.lists;
    }

    if (result.ok) {
      const parsed = wireSchema.safeParse(result.body);
      if (!parsed.success) {
        throw new MarketRequestError(
          `The vocabulary at ${this.#url} answered ${result.status} with a list the SDK cannot read. Nothing was published. Update the SDK.`,
          { status: result.status },
        );
      }

      const lists = toLists(parsed.data);
      this.#entry = { lists, etag: result.etag, readAt: this.#now() };
      return lists;
    }

    if (result.code === "body") {
      throw new MarketRequestError(
        `The vocabulary at ${this.#url} answered ${result.status} with a body that is not JSON. Nothing was published.`,
        { status: result.status },
      );
    }

    const envelope = readEnvelope(result.body);
    const detail = envelope?.message ?? detailOf(result.body);

    if (result.status === 429) {
      throw new MarketRetryError(result.status, result.retryAfterSeconds ?? bodyWaitSeconds(envelope), detail);
    }

    if (result.status >= 500) {
      throw new MarketNetworkError(
        `The vocabulary at ${this.#url} answered ${result.status}, so the SDK checked no term and published nothing. Send the call again later. The platform said: ${detail}`,
        { status: result.status, code: envelope?.code },
      );
    }

    throw new MarketRequestError(
      `The vocabulary at ${this.#url} refused the read with status ${result.status}. Nothing was published. The platform said: ${detail}`,
      { status: result.status, code: envelope?.code },
    );
  }
}

/** The surface `market.vocabulary` returns, over one cache. */
export function vocabularySurface(cache: VocabularyCache): VocabularySurface {
  return {
    categories: async (options) => (await cache.read(options?.signal)).categories,
    integrations: async (options) => (await cache.read(options?.signal)).integrations,
  };
}

/**
 * The issues of one listing against the vocabulary, one per term outside it.
 *
 * The field names follow `validateListing`, so a caller reads one shape for a
 * shape error and a term error.
 */
export function vocabularyIssues(
  listing: { readonly categorySlug: string; readonly integrations: readonly string[] },
  lists: Lists,
  url: string,
): MarketValidationIssue[] {
  const categories = new Set(lists.categories.map((term) => term.slug));
  const integrations = new Set(lists.integrations.map((term) => term.slug));
  const issues: MarketValidationIssue[] = [];

  if (!categories.has(listing.categorySlug)) {
    issues.push({
      field: "categorySlug",
      rule: "unknown_category",
      message: `The category "${listing.categorySlug}" is not in the platform vocabulary. Pick a slug from the categories at ${url}.`,
    });
  }

  listing.integrations.forEach((slug, index) => {
    if (!integrations.has(slug)) {
      issues.push({
        field: `integrations.${index}`,
        rule: "unknown_integration",
        message: `The integration "${slug}" is not in the platform vocabulary. Pick a slug from the integrations at ${url}.`,
      });
    }
  });

  return issues;
}

/**
 * Reads the vocabulary and throws `MarketValidationError` for a listing that
 * names a term outside it. `define()` calls it after the shape check and
 * before the publish.
 */
export async function checkVocabulary(
  cache: VocabularyCache,
  listing: { readonly categorySlug: string; readonly integrations: readonly string[] },
  signal?: AbortSignal,
): Promise<void> {
  const issues = vocabularyIssues(listing, await cache.read(signal), cache.url);
  if (issues.length > 0) throw new MarketValidationError(issues);
}
