import {
  disableProgram,
  readProgram,
  registerProgram,
  type AffiliateSurface,
} from "./affiliate";
import {
  isMarketEventName,
  setMarketHandler,
  type MarketEventHandlerMap,
  type MarketEventName,
} from "./events";
import { request, type RequestResult } from "./http";
import { defineProduct, type ProductSurface } from "./products";
import {
  checkVocabulary,
  DEFAULT_VOCABULARY_TTL_MS,
  VocabularyCache,
  vocabularySurface,
  type VocabularySurface,
} from "./vocabulary";
import { createWebhookHandler, type WebhookSurface } from "./webhooks";

/** The production API host. */
export const DEFAULT_BASE_URL = "https://api.metzia.ai";

export const MISSING_KEY_MESSAGE =
  "Market needs a Metzia seller key. Set METZIA_KEY and pass process.env.METZIA_KEY to new Market().";

/** Names the rejected value, so the reader sees the mistake in one line. */
export function invalidBaseUrlMessage(baseUrl: string): string {
  return `Market cannot use the base URL "${baseUrl}". Pass an absolute URL with no query and no fragment, for example ${DEFAULT_BASE_URL} or http://localhost:3000.`;
}

/** Names the rejected time to live. */
export function invalidVocabularyTtlMessage(ttlMs: unknown): string {
  return `Market cannot use the vocabularyTtlMs ${String(ttlMs)}. Pass a whole number of milliseconds of zero or more, for example ${DEFAULT_VOCABULARY_TTL_MS}.`;
}

/**
 * Checks the time to live the caller gave, or answers the default.
 *
 * A value that is not a whole number of zero or more is a caller defect, so it
 * throws at construction. Zero reads the vocabulary on every `define()`.
 */
function checkVocabularyTtl(ttlMs: unknown): number {
  if (ttlMs === undefined) return DEFAULT_VOCABULARY_TTL_MS;
  if (typeof ttlMs !== "number" || !Number.isSafeInteger(ttlMs) || ttlMs < 0) {
    throw new Error(invalidVocabularyTtlMessage(ttlMs));
  }
  return ttlMs;
}

/** Names the rejected event and the two the caller may register. */
export function unsupportedEventMessage(event: unknown): string {
  return `Market.on does not know the event "${String(event)}". Register "provision" or "cancel".`;
}

/** Names the event whose handler was not callable, and what was passed. */
export function invalidHandlerMessage(event: string, handler: unknown): string {
  return `Market.on("${event}", ...) needs a function. Received ${typeof handler}.`;
}

/**
 * Checks the host the caller gave, and returns it unchanged.
 *
 * A base URL the parser rejects is a caller configuration defect, so it throws
 * at construction. Without this check an empty string reaches `fetch` and the
 * seller reads a network failure on every call. `src/cli.ts` reuses it for
 * `--base-url`. `src/index.ts` does not export it.
 */
export function checkBaseUrl(baseUrl: string): string {
  let parsed: URL;

  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(invalidBaseUrlMessage(baseUrl));
  }

  // A query or a fragment on the base disappears the moment a path joins it.
  // The caller must see that now, not lose a parameter silently later.
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error(invalidBaseUrlMessage(baseUrl));
  }

  return baseUrl;
}

export type MarketOptions = {
  /** Points the client at another host. Local work and a test use it. */
  baseUrl?: string;
  /**
   * Signs the inbound webhook callbacks. It is separate from the platform key
   * so a key rotation does not break callbacks, and it is required before
   * `market.webhooks.handler()` will build a receiver.
   */
  webhookSecret?: string;
  /**
   * How long one vocabulary read stands, in milliseconds. `define()` checks the
   * category and the integrations of a listing against the vocabulary, and
   * reads it at most once in this window. The default is one hour.
   */
  vocabularyTtlMs?: number;
};

/**
 * The entry point of the SDK.
 *
 * One instance holds one platform key and one host. The key stays in a private
 * field, so a log line that serialises the client cannot print it.
 */
export class Market {
  readonly baseUrl: string;
  readonly #key: string;
  readonly #webhookSecret: string | undefined;
  readonly #vocabulary: VocabularyCache;

  constructor(key: string | undefined, options?: MarketOptions) {
    // A missing key is a caller configuration defect, not a runtime answer, so
    // it throws. The parameter accepts `undefined` because an environment read
    // gives that type, and the check also catches a JavaScript caller that
    // passes another type.
    if (typeof key !== "string" || key.trim() === "") {
      throw new Error(MISSING_KEY_MESSAGE);
    }

    // The trimmed value goes on the wire. A padded key would send
    // `Bearer   abc  `, and the API would reject a key the seller typed right.
    this.#key = key.trim();
    this.baseUrl = checkBaseUrl((options?.baseUrl ?? DEFAULT_BASE_URL).trim());

    // A blank secret counts as absent, so a padded environment value cannot
    // build a receiver that only rejects every real callback. The value stays
    // in a private field and never reaches a log line or the public surface.
    const webhookSecret = options?.webhookSecret;

    this.#webhookSecret =
      typeof webhookSecret === "string" && webhookSecret.trim() !== ""
        ? webhookSecret.trim()
        : undefined;

    // One cache for the life of this instance, so two define() calls make one
    // vocabulary read. It holds the bound call and never the key.
    this.#vocabulary = new VocabularyCache(
      (path, init) => this.request<unknown>(path, init),
      this.baseUrl,
      checkVocabularyTtl(options?.vocabularyTtlMs),
    );
  }

  /**
   * The webhook receiver setup surface.
   *
   * `handler()` returns a Web Request to Response function, or throws when no
   * webhook secret was configured. The secret itself is not exposed. The
   * receiver reads the private handler registry, so it reaches only the
   * handlers the seller registered through `on`.
   */
  get webhooks(): WebhookSurface {
    return {
      handler: () => createWebhookHandler(this, this.#webhookSecret),
    };
  }

  /**
   * The catalog publish surface.
   *
   * `define()` validates the listing, checks its category and integrations
   * against the vocabulary, then publishes it under a new idempotency key. The
   * publish module receives one bound call and never the platform key.
   */
  get products(): ProductSurface {
    return {
      define: (input, options) =>
        defineProduct((path, init) => this.request<unknown>(path, init), input, options, (listing, signal) =>
          checkVocabulary(this.#vocabulary, listing, signal),
        ),
    };
  }

  /**
   * The vocabulary a listing may name: the categories and the integrations the
   * platform lists at `/api/vocabulary`. The reads share the cache `define()`
   * uses.
   */
  get vocabulary(): VocabularySurface {
    return vocabularySurface(this.#vocabulary);
  }

  /**
   * The affiliate program surface.
   *
   * WARNING: new terms stop commission until staff approve them again.
   * `register()` with a changed rate, term, or template opens a version that
   * staff must approve. Read `get()` first, and register only on a real change.
   */
  get affiliate(): AffiliateSurface {
    const send = (path: string, init: RequestInit): Promise<RequestResult<unknown>> =>
      this.request<unknown>(path, init);

    return {
      register: (input, options) => registerProgram(send, input, options),
      get: (options) => readProgram(send, options),
      disable: (options) => disableProgram(send, options),
    };
  }

  /**
   * Registers the handler for one seller event.
   *
   * The name type allows only `provision` and `cancel`, so `on("reserve", ...)`
   * fails compilation. A JavaScript caller reaches the function with any string,
   * so the runtime guard refuses a name outside the two. The same caller can
   * pass a non-function handler, which would otherwise surface much later as an
   * opaque 500 on every real callback, so registration refuses that too.
   *
   * A second registration for the same event replaces the first. The last
   * handler a seller registers is the one the platform calls.
   */
  on<K extends MarketEventName>(
    event: K,
    handler: MarketEventHandlerMap[K],
  ): void {
    if (!isMarketEventName(event)) {
      throw new Error(unsupportedEventMessage(event));
    }

    if (typeof handler !== "function") {
      throw new Error(invalidHandlerMessage(event, handler));
    }

    setMarketHandler(this, event, handler);
  }

  /** Calls one API path with the key and the host of this instance. */
  request<T>(path: string, init?: RequestInit): Promise<RequestResult<T>> {
    return request<T>(this.#key, this.baseUrl, path, init);
  }
}
