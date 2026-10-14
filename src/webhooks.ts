import {
  getMarketHandler,
  type CancelEvent,
  type ProvisionEvent,
  type ProvisionResult,
} from "./events";

/**
 * The signed webhook receiver.
 *
 * The platform signs the exact raw body with HMAC-SHA256 over
 * `<unix timestamp>.<raw body>` and sends it in one versioned header:
 * `Metzia-Signature: t=<unix timestamp>,v1=<hex digest>`. The receiver reads
 * the body once, verifies the timestamped digest, and only then parses and
 * dispatches. A missing, malformed, stale, future-skewed, or mismatched
 * signature never reaches a handler.
 *
 * The signing secret is separate from the seller API key: key
 * rotation must not break callbacks. `Market.webhooks.handler()` refuses to
 * build a receiver without one.
 *
 * The verification uses `crypto.subtle.verify`, not string equality, so the
 * comparison does not branch on the matching bytes. The receiver keeps its
 * dispatcher in the private registry the seller wrote through `Market.on`.
 */

/** The one signature header. The version is in the value, not the name. */
export const SIGNATURE_HEADER = "Metzia-Signature";

/** How far a timestamp may sit from the receiver clock, in seconds. */
export const REPLAY_WINDOW_SECONDS = 300;

/** The configuration error `handler()` throws before it reads a request. */
export const MISSING_WEBHOOK_SECRET_MESSAGE =
  "Market.webhooks.handler needs a webhook signing secret. Pass webhookSecret to new Market() before you register the receiver.";

/** One body that fails its signature check. The reason stays out of the answer. */
export const INVALID_SIGNATURE_MESSAGE =
  "The webhook signature is missing or not valid.";

/** The body did not parse as JSON. */
export const MALFORMED_BODY_MESSAGE = "The webhook body is not valid JSON.";

/** The envelope or its fields did not match a known event. */
export const INVALID_EVENT_MESSAGE = "The webhook body is not a valid event.";

/** A handler was absent, threw, or answered with a result the SDK rejects. */
export const HANDLER_FAILURE_MESSAGE = "The webhook handler did not complete.";

/**
 * The body could not be read.
 *
 * A stream that errors mid-request, or a body a framework or seller already
 * consumed before dispatch, reaches this instead of rejecting out of the
 * receiver.
 */
export const UNREADABLE_BODY_MESSAGE = "The webhook body could not be read.";

/**
 * The signing key could not be imported.
 *
 * `crypto.subtle` is absent in a browser on an insecure origin and in a
 * runtime without WebCrypto. That is a deployment defect, not a caller error,
 * so the receiver answers 500 rather than rejecting.
 */
export const SIGNATURE_KEY_FAILURE_MESSAGE =
  "The webhook receiver could not verify the signature.";

/** The stable answer a successful cancel receives. */
export const CANCEL_RESPONSE = { ok: true } as const;

/** The Web Request to Response function a seller mounts. */
export type WebhookRequestHandler = (request: Request) => Promise<Response>;

/** The setup surface `Market.webhooks` exposes. The secret stays inside. */
export type WebhookSurface = {
  handler(): WebhookRequestHandler;
};

/** The two registered events, as the signed body carries them. */
export type WebhookEnvelope =
  | { type: "provision"; data: ProvisionEvent }
  | { type: "cancel"; data: CancelEvent };

/** A parsed signature header, with the raw timestamp kept for the digest. */
export type ParsedSignature = {
  /** The exact text between `t=` and the next comma. */
  timestamp: string;
  /** The same value as a number, for the replay window. */
  seconds: number;
  /** The hex digest between `v1=` and the next comma. */
  signature: string;
};

const encoder = new TextEncoder();

/**
 * Parses one `t=<unix>,v1=<hex>` header.
 *
 * Unknown keys are ignored, because a later scheme may add one. A component
 * without `=`, a non-numeric timestamp, an empty part, or a missing `t` or
 * `v1` makes the header malformed and returns `undefined`.
 */
export function parseSignatureHeader(
  header: string | null,
): ParsedSignature | undefined {
  if (header === null) {
    return undefined;
  }

  let timestamp: string | undefined;
  let signature: string | undefined;

  for (const part of header.split(",")) {
    const separator = part.indexOf("=");

    if (separator === -1) {
      return undefined;
    }

    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (value === "") {
      return undefined;
    }

    if (name === "t") {
      timestamp = value;
    } else if (name === "v1") {
      signature = value;
    }
  }

  if (timestamp === undefined || signature === undefined) {
    return undefined;
  }

  if (!/^\d+$/.test(timestamp)) {
    return undefined;
  }

  const seconds = Number(timestamp);

  if (!Number.isSafeInteger(seconds)) {
    return undefined;
  }

  return { timestamp, seconds, signature };
}

/** Decodes a hex string, or returns `undefined` when it is not hex. */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | undefined {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return undefined;
  }

  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}

/** Encodes bytes as lowercase hex. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";

  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return hex;
}

/** Imports the secret once, for the one usage the caller names. */
async function importHmacKey(
  secret: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

/** The message the platform signs. The timestamp is literal. */
export function signedMessage(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/**
 * Signs one message with HMAC-SHA256 and returns the lowercase hex digest.
 *
 * `signTestEvent` uses this, so a local test signs through the same primitive
 * the receiver verifies with.
 */
export async function signHmacHex(
  secret: string,
  message: string,
): Promise<string> {
  const key = await importHmacKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message),
  );

  return bytesToHex(new Uint8Array(signature));
}

/**
 * Verifies one hex digest through `crypto.subtle.verify`.
 *
 * A malformed hex digest is not a valid signature. The comparison itself is
 * the platform's HMAC verify, so it does not branch on matching bytes.
 */
export async function verifyHmacHex(
  key: CryptoKey,
  timestamp: string,
  rawBody: string,
  signatureHex: string,
): Promise<boolean> {
  const signature = hexToBytes(signatureHex);

  if (signature === undefined) {
    return false;
  }

  return crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(signedMessage(timestamp, rawBody)),
  );
}

/** A JSON error answer. It names no handler and no thrown value. */
function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A non-empty string after trimming. The dispatch keeps the original text. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Narrows unchecked JSON to a provision payload with all three fields. */
function toProvisionEvent(data: unknown): ProvisionEvent | undefined {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }

  const record = data as Record<string, unknown>;

  if (
    !isNonEmptyString(record.buyerId) ||
    !isNonEmptyString(record.sku) ||
    !isNonEmptyString(record.orderId)
  ) {
    return undefined;
  }

  return {
    buyerId: record.buyerId,
    sku: record.sku,
    orderId: record.orderId,
  };
}

/**
 * Checks the value a provision handler answered with.
 *
 * The inbound event is validated strictly, and the answer is what the platform
 * records as the account. A JavaScript seller, or a handler typed `any`, can
 * return nothing: `JSON.stringify(undefined)` is `undefined`, so an unchecked
 * answer becomes a 200 with an empty body and the platform stores no account
 * id. A result that does not carry both fields is a handler failure.
 */
function isProvisionResult(value: unknown): value is ProvisionResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    isNonEmptyString(record.externalAccountId) &&
    typeof record.created === "boolean"
  );
}

/** Narrows unchecked JSON to a cancel payload with both fields. */
function toCancelEvent(data: unknown): CancelEvent | undefined {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }

  const record = data as Record<string, unknown>;

  if (
    !isNonEmptyString(record.externalAccountId) ||
    !isNonEmptyString(record.sku)
  ) {
    return undefined;
  }

  return { externalAccountId: record.externalAccountId, sku: record.sku };
}

/**
 * Narrows unchecked JSON to a `{ type, data }` envelope.
 *
 * `reserve` and `confirm` are not seller events, so an envelope that names one
 * fails here and never reaches the registry.
 */
export function toWebhookEnvelope(
  payload: unknown,
): WebhookEnvelope | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  const record = payload as Record<string, unknown>;

  if (record.type === "provision") {
    const data = toProvisionEvent(record.data);
    return data === undefined ? undefined : { type: "provision", data };
  }

  if (record.type === "cancel") {
    const data = toCancelEvent(record.data);
    return data === undefined ? undefined : { type: "cancel", data };
  }

  return undefined;
}

/**
 * Builds the Request to Response handler for one market.
 *
 * A missing or blank secret is a setup defect, so the function throws here,
 * when `handler()` runs, not on the first request. The imported key is created
 * once per handler, and the body is read once per request.
 */
export function createWebhookHandler(
  market: object,
  secret: string | undefined,
): WebhookRequestHandler {
  const configured = secret?.trim();

  if (configured === undefined || configured === "") {
    throw new Error(MISSING_WEBHOOK_SECRET_MESSAGE);
  }

  const key = importHmacKey(configured, ["verify"]);

  // The import starts now and is awaited on the first request. Without this
  // sink a runtime without `crypto.subtle` raises an unhandled rejection at
  // module load, which ends the Node process before any request arrives. The
  // request path awaits the same promise and turns the failure into a 500.
  key.catch(() => undefined);

  return async (request) => {
    let rawBody: string;

    try {
      rawBody = await request.text();
    } catch {
      return errorResponse(400, UNREADABLE_BODY_MESSAGE);
    }

    const parsed = parseSignatureHeader(
      request.headers.get(SIGNATURE_HEADER),
    );

    if (parsed === undefined) {
      return errorResponse(401, INVALID_SIGNATURE_MESSAGE);
    }

    const nowSeconds = Math.floor(Date.now() / 1000);

    if (Math.abs(nowSeconds - parsed.seconds) > REPLAY_WINDOW_SECONDS) {
      return errorResponse(401, INVALID_SIGNATURE_MESSAGE);
    }

    let verifyKey: CryptoKey;

    try {
      verifyKey = await key;
    } catch {
      return errorResponse(500, SIGNATURE_KEY_FAILURE_MESSAGE);
    }

    const valid = await verifyHmacHex(
      verifyKey,
      parsed.timestamp,
      rawBody,
      parsed.signature,
    );

    if (!valid) {
      return errorResponse(401, INVALID_SIGNATURE_MESSAGE);
    }

    let payload: unknown;

    try {
      payload = JSON.parse(rawBody);
    } catch {
      return errorResponse(400, MALFORMED_BODY_MESSAGE);
    }

    const envelope = toWebhookEnvelope(payload);

    if (envelope === undefined) {
      return errorResponse(400, INVALID_EVENT_MESSAGE);
    }

    if (envelope.type === "provision") {
      const handler = getMarketHandler(market, "provision");

      if (handler === undefined) {
        return errorResponse(500, HANDLER_FAILURE_MESSAGE);
      }

      let result: unknown;

      try {
        result = await handler(envelope.data);
      } catch {
        return errorResponse(500, HANDLER_FAILURE_MESSAGE);
      }

      if (!isProvisionResult(result)) {
        return errorResponse(500, HANDLER_FAILURE_MESSAGE);
      }

      return new Response(
        JSON.stringify({
          externalAccountId: result.externalAccountId,
          created: result.created,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    const handler = getMarketHandler(market, "cancel");

    if (handler === undefined) {
      return errorResponse(500, HANDLER_FAILURE_MESSAGE);
    }

    try {
      await handler(envelope.data);

      return new Response(JSON.stringify(CANCEL_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch {
      return errorResponse(500, HANDLER_FAILURE_MESSAGE);
    }
  };
}
