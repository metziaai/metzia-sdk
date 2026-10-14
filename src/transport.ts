import { z } from "zod";

import type { MarketValidationIssue } from "./errors";
import type { RequestResult } from "./http";

/**
 * The retry loop and the error envelope that every surface of this SDK shares.
 *
 * `products.ts` and `affiliate.ts` both send one call, retry a network failure,
 * and read the same error body, so the rules live here once. `index.ts` exports nothing from here: the module is internal.
 *
 * Every surface keeps its own answer reader. The messages name the listing or
 * the program, and they state what the caller does next, so one shared reader
 * would say less than either.
 */

/** How many times a network failure is sent again. */
export const RETRIES = 3;

/** The longest wait before the first retry. Each later ceiling doubles it. */
export const FIRST_BACKOFF_MS = 200;

/**
 * The wait before retry `attempt`, counted from zero.
 *
 * The wait is a random point in the upper half of the doubled ceiling. Many
 * clients that lose the network together would otherwise retry at the same
 * instants. The lower half stays empty, so a retry never comes sooner than
 * half the ceiling.
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = FIRST_BACKOFF_MS * 2 ** attempt;
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** The answers a surface maps. A network failure never reaches them. */
export type Answered = Exclude<RequestResult<unknown>, { code: "network" }>;

/** Sends one call. `Market` binds the platform key and the base URL to it. */
export type Send = (path: string, init: RequestInit) => Promise<RequestResult<unknown>>;

export const envelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z
      .array(z.object({ field: z.string(), code: z.string(), message: z.string() }))
      .optional(),
    retry_after_seconds: z.number().optional(),
  }),
});

export type ErrorEnvelope = z.infer<typeof envelopeSchema>["error"];

/** What one caller adds to the shared loop. */
export type SendOptions = {
  /**
   * The error a caller reads when every attempt failed on the network.
   *
   * The surface builds it, because only the surface knows what the call may
   * have written and how the caller reads the outcome back.
   */
  readonly exhausted: (cause: unknown) => Error;

  /** Stops the call and every retry of it, and ends a wait at once. */
  readonly signal?: AbortSignal | undefined;

  /**
   * Reads an answer the platform did deliver.
   *
   * It returns a wait in milliseconds to send the call again, or null to
   * return the answer. It reads how many network failures this call already
   * took, because only a call that lost an answer may wait for its own earlier
   * attempt. A surface that never waits passes nothing.
   */
  readonly waitFor?: (result: Answered, networkFailures: number) => number | null;
};

/**
 * Sends one call, and sends it again after a network failure.
 *
 * A network failure never delivered an answer, so the loop sends the call again
 * up to three times. Every other answer is the platform's decision and stands,
 * unless `waitFor` names a wait.
 */
export async function sendWithRetry(
  send: Send,
  path: string,
  init: RequestInit,
  options: SendOptions,
): Promise<Answered> {
  const { exhausted, signal, waitFor } = options;

  let networkFailures = 0;

  for (;;) {
    signal?.throwIfAborted();

    const result = await send(path, init);

    if (!result.ok && result.code === "network") {
      // An abort arrives here as a failed fetch. It is the caller's decision
      // and not a fault of the network, so it ends the call.
      signal?.throwIfAborted();

      if (networkFailures === RETRIES) throw exhausted(result.error);

      await sleep(backoffMs(networkFailures), signal);
      networkFailures += 1;
      continue;
    }

    const wait = waitFor?.(result, networkFailures) ?? null;

    if (wait === null) return result;

    await sleep(wait, signal);
  }
}

/**
 * Waits, and ends the wait when the caller aborts.
 *
 * A timer that outlives the abort holds the wait open for its full length, and
 * the caller reads the abort that much later.
 */
export function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };

    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The error envelope of a route, or undefined for every other body. */
export function readEnvelope(body: string): ErrorEnvelope | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    // A gateway answers with HTML, and the raw text reaches the reader instead.
    return undefined;
  }

  const envelope = envelopeSchema.safeParse(parsed);
  return envelope.success ? envelope.data.error : undefined;
}

/**
 * The wait the body names, or null.
 *
 * It follows the rule the `Retry-After` header follows: a positive integer of
 * seconds and nothing else. One rule keeps the two sources readable as one.
 */
export function bodyWaitSeconds(envelope: ErrorEnvelope | undefined): number | null {
  const seconds = envelope?.retry_after_seconds;

  if (seconds === undefined || !Number.isInteger(seconds) || seconds <= 0) return null;

  return seconds;
}

/** The raw body, or a stated absence. An empty message reads as a defect. */
export function detailOf(body: string): string {
  return body.trim() === "" ? "nothing" : body;
}

/**
 * One issue per field the platform named.
 *
 * A route sends `code` where an SDK validator sends `rule`, and both name the
 * rule that refused the value, so a caller reads one shape for a local failure
 * and a server failure.
 */
export function envelopeIssues(
  envelope: ErrorEnvelope | undefined,
): readonly MarketValidationIssue[] {
  return (envelope?.fields ?? []).map((field) => ({
    field: field.field,
    rule: field.code,
    message: field.message,
  }));
}
