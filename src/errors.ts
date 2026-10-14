export type MarketValidationIssue = {
  readonly field: string;
  readonly rule: string;
  readonly message: string;
};

/** A listing validation failure, with every problem in wire-field form. */
export class MarketValidationError extends Error {
  readonly errors: readonly MarketValidationIssue[];

  constructor(errors: readonly MarketValidationIssue[]) {
    super("The listing is invalid.");
    this.name = "MarketValidationError";
    this.errors = Object.freeze(errors.map((error) => Object.freeze({ ...error })));
  }

  toJSON(): { readonly name: string; readonly message: string; readonly errors: readonly MarketValidationIssue[] } {
    return { name: this.name, message: this.message, errors: this.errors };
  }
}

/**
 * One idempotency key already names another payload.
 *
 * The platform stores the first payload under the key and refuses a second
 * payload under the same key. The error names the listing, so the reader sees
 * which payload changed.
 *
 * The error holds the key nowhere. A caller that names a key already holds it,
 * and a property here would reach every log line that prints the error.
 */
export class MarketConflictError extends Error {
  readonly sku: string;

  constructor(sku: string, detail: string) {
    super(
      `The publish of the listing ${sku} was refused and nothing was written. An earlier call sent another payload under the same idempotency key. Send the first payload again, or pass a new idempotencyKey to define(). The platform said: ${detail}`,
    );
    this.name = "MarketConflictError";
    this.sku = sku;
  }

  toJSON(): { readonly name: string; readonly message: string; readonly sku: string } {
    return { name: this.name, message: this.message, sku: this.sku };
  }
}

/** The message of one retry error. Each status states its own outcome. */
function retryMessage(status: number, retryAfterSeconds: number | null, detail: string): string {
  const wait = retryAfterSeconds === null ? "Wait" : `Wait ${retryAfterSeconds} seconds`;

  if (status === 429) {
    return `The platform answered ${status} and nothing was written. ${wait}, then send the same call again. The platform said: ${detail}`;
  }

  return `The platform answered ${status}, and the outcome of the call is unknown. ${wait}, then send the same call again. The platform holds one listing for one sku, so a second call writes no duplicate. The platform said: ${detail}`;
}

/**
 * The platform refused the call for now and names when to send it again.
 *
 * A rate limit, a call that is still in flight under the same key, and a
 * dependency the platform cannot reach all read this way. The same call is
 * safe to send again, because it carries the same idempotency key.
 *
 * The message states the outcome of the call. A 429 arrives before the write,
 * so that call wrote nothing. A 409 names a call this one cannot see, and a
 * 5xx names a step the platform started, so the outcome of both is unknown.
 *
 * `retryAfterSeconds` is null when the answer names no wait time. The SDK
 * invents no number, because a guess sends the next call at the wrong moment.
 */
export class MarketRetryError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, retryAfterSeconds: number | null, detail: string) {
    super(retryMessage(status, retryAfterSeconds, detail));
    this.name = "MarketRetryError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  toJSON(): {
    readonly name: string;
    readonly message: string;
    readonly status: number;
    readonly retryAfterSeconds: number | null;
  } {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }
}

/**
 * A call the SDK cannot turn into a result.
 *
 * It carries a network failure that outlived every retry, an answer the SDK
 * cannot read, and every refusal the SDK does not map to a named error above.
 * `status` is null when no answer arrived. `code` is the platform error code,
 * and it is null when the answer named none.
 */
export class MarketRequestError extends Error {
  readonly status: number | null;
  readonly code: string | null;

  constructor(
    message: string,
    options?: {
      readonly status?: number;
      readonly code?: string;
      readonly cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = "MarketRequestError";
    this.status = options?.status ?? null;
    this.code = options?.code ?? null;
  }

  toJSON(): {
    readonly name: string;
    readonly message: string;
    readonly status: number | null;
    readonly code: string | null;
  } {
    return { name: this.name, message: this.message, status: this.status, code: this.code };
  }
}

/**
 * A read the SDK needs before a call could not reach the platform, or the
 * platform could not answer it.
 *
 * The vocabulary read before a publish throws it: after every network retry
 * failed, or when the vocabulary endpoint answered with a server error. The
 * listing was not published, and nothing was written. It is not a
 * `MarketValidationError`, because the listing may be valid: the SDK could not
 * check it. Send the same call again later.
 *
 * It extends `MarketRequestError`, so a caller that already catches that class
 * catches this one too. `status` is null when no answer arrived, and the
 * server status otherwise.
 */
export class MarketNetworkError extends MarketRequestError {
  constructor(
    message: string,
    options?: {
      readonly status?: number;
      readonly code?: string;
      readonly cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = "MarketNetworkError";
  }
}
