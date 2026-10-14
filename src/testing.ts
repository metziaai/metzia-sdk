import {
  SIGNATURE_HEADER,
  signHmacHex,
  signedMessage,
  type WebhookEnvelope,
} from "./webhooks";

/**
 * The local test signer.
 *
 * `signTestEvent` builds the same signed Web `Request` the platform sends, so
 * a test and the later certification command exercise the receiver through its
 * real wire contract. It lives on the `@metzia/sdk/testing` subpath only. The
 * main entry point does not export it, and a seller process never imports it.
 *
 * The helper signs `<timestamp>.<canonical JSON body>` with HMAC-SHA256 and
 * writes `Metzia-Signature: t=<unix timestamp>,v1=<hex digest>`. A caller may
 * pin the timestamp to test the replay window.
 */

/** Where a signed test event lands unless the caller names a URL. */
export const DEFAULT_TEST_URL = "https://example.test/metzia-webhooks";

/** The configuration error an empty secret receives. */
export const MISSING_TEST_SECRET_MESSAGE =
  "signTestEvent needs a non-empty webhook signing secret.";

/** One signed event to send. The envelope is the exact received shape. */
export type SignTestEventInput = {
  /** The signing secret, the same value the receiver was configured with. */
  secret: string;
  /** The `{ type, data }` envelope to serialize and sign. */
  event: WebhookEnvelope;
  /** The destination. It defaults to `DEFAULT_TEST_URL`. */
  url?: string;
  /** Unix seconds. It defaults to the clock, and a test may pin it. */
  timestamp?: number;
};

/**
 * Serializes and signs one event into a Web `Request`.
 *
 * The body is `JSON.stringify(event)`, and the signature covers exactly that
 * text. The receiver reads the same bytes, so the two never disagree about the
 * canonical form.
 */
export async function signTestEvent(
  input: SignTestEventInput,
): Promise<Request> {
  const secret = input.secret.trim();

  if (secret === "") {
    throw new Error(MISSING_TEST_SECRET_MESSAGE);
  }

  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const timestampText = String(timestamp);
  const body = JSON.stringify(input.event);
  const signature = await signHmacHex(
    secret,
    signedMessage(timestampText, body),
  );

  return new Request(input.url ?? DEFAULT_TEST_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SIGNATURE_HEADER]: `t=${timestampText},v1=${signature}`,
    },
    body,
  });
}
