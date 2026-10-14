import { describe, expect, it, vi } from "vitest";

import type { CancelEvent, ProvisionEvent } from "./events";
import { Market } from "./market";
import {
  CANCEL_RESPONSE,
  HANDLER_FAILURE_MESSAGE,
  INVALID_EVENT_MESSAGE,
  INVALID_SIGNATURE_MESSAGE,
  MALFORMED_BODY_MESSAGE,
  MISSING_WEBHOOK_SECRET_MESSAGE,
  REPLAY_WINDOW_SECONDS,
  SIGNATURE_HEADER,
  SIGNATURE_KEY_FAILURE_MESSAGE,
  UNREADABLE_BODY_MESSAGE,
  signedMessage,
  signHmacHex,
} from "./webhooks";
import { DEFAULT_TEST_URL, signTestEvent } from "./testing";

const KEY = "test-key";
const SECRET = "test-webhook-secret";

const PROVISION: ProvisionEvent = {
  buyerId: "byr_a9f3",
  sku: "pro",
  orderId: "ord_123",
};

const CANCEL: CancelEvent = {
  externalAccountId: "acme_usr_88",
  sku: "pro",
};

/** A market with a secret and its receiver. */
function marketWithSecret(): Market {
  return new Market(KEY, { webhookSecret: SECRET });
}

/** Signs one raw body by hand, for the cases the test signer does not build. */
async function signedRawRequest(
  rawBody: string,
  options?: { secret?: string; timestamp?: number; header?: string | null },
): Promise<Request> {
  const secret = options?.secret ?? SECRET;
  const timestamp = options?.timestamp ?? Math.floor(Date.now() / 1000);
  const timestampText = String(timestamp);
  const signature = await signHmacHex(
    secret,
    signedMessage(timestampText, rawBody),
  );

  const headers = new Headers({ "content-type": "application/json" });
  const header =
    options && "header" in options
      ? options.header ?? null
      : `t=${timestampText},v1=${signature}`;

  if (header !== null) {
    headers.set(SIGNATURE_HEADER, header);
  }

  return new Request(DEFAULT_TEST_URL, {
    method: "POST",
    headers,
    body: rawBody,
  });
}

describe("Market.webhooks.handler setup", () => {
  it("throws when no webhook secret was configured and names webhookSecret", () => {
    const market = new Market(KEY);

    expect(() => market.webhooks.handler()).toThrow(
      MISSING_WEBHOOK_SECRET_MESSAGE,
    );
  });

  it("throws on a blank webhook secret", () => {
    const market = new Market(KEY, { webhookSecret: "   " });

    expect(() => market.webhooks.handler()).toThrow(
      MISSING_WEBHOOK_SECRET_MESSAGE,
    );
  });

  it("returns a receiver when a secret was configured", () => {
    expect(marketWithSecret().webhooks.handler()).toBeTypeOf("function");
  });
});

describe("the signed receiver signature check", () => {
  it("accepts a signed provision event before dispatch", async () => {
    const market = marketWithSecret();
    const handler = vi.fn(async (event: ProvisionEvent) => ({
      externalAccountId: `acme_${event.buyerId}`,
      created: true,
    }));
    market.on("provision", handler);

    const response = await market.webhooks.handler()(
      await signTestEvent({
        secret: SECRET,
        event: { type: "provision", data: PROVISION },
      }),
    );

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(PROVISION);
  });

  it("returns 401 when the signature header is missing", async () => {
    const market = marketWithSecret();
    const response = await market.webhooks.handler()(
      await signedRawRequest(JSON.stringify({ type: "provision", data: PROVISION }), {
        header: null,
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: INVALID_SIGNATURE_MESSAGE,
    });
  });

  it("returns 401 for a malformed signature header", async () => {
    const market = marketWithSecret();
    const response = await market.webhooks.handler()(
      await signedRawRequest(JSON.stringify({ type: "provision", data: PROVISION }), {
        header: "not-a-signature",
      }),
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 for a non-numeric timestamp", async () => {
    const market = marketWithSecret();
    const response = await market.webhooks.handler()(
      await signedRawRequest(JSON.stringify({ type: "provision", data: PROVISION }), {
        header: "t=soon,v1=abcdef",
      }),
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 for a mismatched signature", async () => {
    const market = marketWithSecret();
    const response = await market.webhooks.handler()(
      await signedRawRequest(JSON.stringify({ type: "provision", data: PROVISION }), {
        secret: "another-secret",
      }),
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 for a non-hex signature digest", async () => {
    const market = marketWithSecret();
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await market.webhooks.handler()(
      await signedRawRequest(JSON.stringify({ type: "provision", data: PROVISION }), {
        header: `t=${timestamp},v1=zzzz`,
      }),
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 for a stale timestamp outside the replay window", async () => {
    const market = marketWithSecret();
    const timestamp = Math.floor(Date.now() / 1000) - REPLAY_WINDOW_SECONDS - 1;
    const response = await market.webhooks.handler()(
      await signTestEvent({
        secret: SECRET,
        event: { type: "provision", data: PROVISION },
        timestamp,
      }),
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 for a future-skewed timestamp outside the replay window", async () => {
    const market = marketWithSecret();
    const timestamp = Math.floor(Date.now() / 1000) + REPLAY_WINDOW_SECONDS + 1;
    const response = await market.webhooks.handler()(
      await signTestEvent({
        secret: SECRET,
        event: { type: "provision", data: PROVISION },
        timestamp,
      }),
    );

    expect(response.status).toBe(401);
  });

  it("rejects a tampered body even when the header is intact", async () => {
    const market = marketWithSecret();
    const original = await signTestEvent({
      secret: SECRET,
      event: { type: "provision", data: PROVISION },
    });
    const originalHeader = original.headers.get(SIGNATURE_HEADER);

    const tampered = new Request(DEFAULT_TEST_URL, {
      method: "POST",
      headers: { [SIGNATURE_HEADER]: originalHeader ?? "" },
      body: JSON.stringify({
        type: "provision",
        data: { ...PROVISION, orderId: "ord_evil" },
      }),
    });

    const response = await market.webhooks.handler()(tampered);

    expect(response.status).toBe(401);
  });
});

describe("the signed receiver body check", () => {
  it("returns 400 for malformed JSON after a valid signature", async () => {
    const market = marketWithSecret();
    const response = await market.webhooks.handler()(
      await signedRawRequest("this is not json"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: MALFORMED_BODY_MESSAGE,
    });
  });

  it("returns 400 for a provision body with no sku", async () => {
    const market = marketWithSecret();
    market.on("provision", () => ({
      externalAccountId: "acme_usr_88",
      created: true,
    }));

    const response = await market.webhooks.handler()(
      await signTestEvent({
        secret: SECRET,
        event: {
          type: "provision",
          data: { buyerId: "byr_a9f3", orderId: "ord_123" } as ProvisionEvent,
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: INVALID_EVENT_MESSAGE,
    });
  });

  it("returns 400 for an empty sku", async () => {
    const market = marketWithSecret();
    market.on("provision", () => ({
      externalAccountId: "acme_usr_88",
      created: true,
    }));

    const response = await market.webhooks.handler()(
      await signTestEvent({
        secret: SECRET,
        event: {
          type: "provision",
          data: { ...PROVISION, sku: "   " },
        },
      }),
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 for a cancel body with no externalAccountId", async () => {
    const market = marketWithSecret();
    const response = await market.webhooks.handler()(
      await signTestEvent({
        secret: SECRET,
        event: {
          type: "cancel",
          data: { sku: "pro" } as CancelEvent,
        },
      }),
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 for an unsupported event type and dispatches nothing", async () => {
    const market = marketWithSecret();
    const handler = vi.fn();
    market.on("provision", handler);

    const response = await market.webhooks.handler()(
      await signTestEvent({
        secret: SECRET,
        // The signer accepts any envelope the receiver defines; a reserve
        // envelope is cast in so the runtime guard, not the type, is tested.
        event: {
          type: "reserve",
          data: { sku: "pro" },
        } as never,
      }),
    );

    expect(response.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown event type and dispatches nothing", async () => {
    const market = marketWithSecret();
    const handler = vi.fn();
    market.on("cancel", handler);

    const response = await market.webhooks.handler()(
      await signTestEvent({
        secret: SECRET,
        event: { type: "confirm", data: { sku: "pro" } } as never,
      }),
    );

    expect(response.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("the signed receiver dispatch", () => {
  it("returns the exact provision result with status 200", async () => {
    const market = marketWithSecret();
    market.on("provision", async () => ({
      externalAccountId: "acme_usr_88",
      created: false,
    }));

    const response = await market.webhooks.handler()(
      await signTestEvent({
        secret: SECRET,
        event: { type: "provision", data: PROVISION },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      externalAccountId: "acme_usr_88",
      created: false,
    });
  });

  it("gives the provision handler its exact payload", async () => {
    const market = marketWithSecret();
    let received: ProvisionEvent | undefined;
    market.on("provision", (event) => {
      received = event;
      return { externalAccountId: "acme_usr_88", created: true };
    });

    await market.webhooks.handler()(
      await signTestEvent({
        secret: SECRET,
        event: { type: "provision", data: PROVISION },
      }),
    );

    expect(received).toEqual(PROVISION);
  });

  it("dispatches a cancel event and returns the stable response", async () => {
    const market = marketWithSecret();
    const handler = vi.fn();
    market.on("cancel", handler);

    const response = await market.webhooks.handler()(
      await signTestEvent({
        secret: SECRET,
        event: { type: "cancel", data: CANCEL },
      }),
    );

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(CANCEL);
    await expect(response.json()).resolves.toEqual(CANCEL_RESPONSE);
  });

  it("calls only the last handler registered for an event", async () => {
    const market = marketWithSecret();
    const first = vi.fn();
    const second = vi.fn();
    market.on("cancel", first);
    market.on("cancel", second);

    await market.webhooks.handler()(
      await signTestEvent({
        secret: SECRET,
        event: { type: "cancel", data: CANCEL },
      }),
    );

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(CANCEL);
  });

  it("returns a non-leaking 500 when no handler is registered", async () => {
    const market = marketWithSecret();

    const response = await market.webhooks.handler()(
      await signTestEvent({
        secret: SECRET,
        event: { type: "provision", data: PROVISION },
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: HANDLER_FAILURE_MESSAGE,
    });
  });

  it("returns a non-leaking 500 when a handler throws", async () => {
    const market = marketWithSecret();
    market.on("provision", () => {
      throw new Error("internal database password leaked here");
    });

    const response = await market.webhooks.handler()(
      await signTestEvent({
        secret: SECRET,
        event: { type: "provision", data: PROVISION },
      }),
    );

    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain("database password");
    expect(JSON.parse(body)).toEqual({ error: HANDLER_FAILURE_MESSAGE });
  });

  it("returns a 500 when a cancel handler throws", async () => {
    const market = marketWithSecret();
    market.on("cancel", () => {
      throw new Error("cancel exploded");
    });

    const response = await market.webhooks.handler()(
      await signTestEvent({
        secret: SECRET,
        event: { type: "cancel", data: CANCEL },
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("cancel exploded");
  });

  it("verifies a padded secret through the trimmed value", async () => {
    const market = new Market(KEY, { webhookSecret: `  ${SECRET}  ` });
    market.on("cancel", () => {});

    const response = await market.webhooks.handler()(
      await signTestEvent({
        secret: SECRET,
        event: { type: "cancel", data: CANCEL },
      }),
    );

    expect(response.status).toBe(200);
  });
});

describe("Market.webhooks.handler failure containment", () => {
  it("answers 400 when the body cannot be read", async () => {
    const market = marketWithSecret();
    market.on("cancel", () => {});

    const request = await signTestEvent({
      secret: SECRET,
      event: { type: "cancel", data: CANCEL },
    });

    vi.spyOn(request, "text").mockRejectedValue(new Error("stream closed"));

    const response = await market.webhooks.handler()(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: UNREADABLE_BODY_MESSAGE,
    });
  });

  it("answers 500 when the signing key cannot be imported", async () => {
    const importKey = vi
      .spyOn(crypto.subtle, "importKey")
      .mockRejectedValue(new Error("crypto.subtle is not available"));

    try {
      const market = marketWithSecret();
      market.on("cancel", () => {});
      const handler = market.webhooks.handler();

      // A fresh timestamp, so the request reaches the key rather than the
      // replay window check.
      const timestamp = String(Math.floor(Date.now() / 1000));

      const response = await handler(
        new Request(DEFAULT_TEST_URL, {
          method: "POST",
          headers: { [SIGNATURE_HEADER]: `t=${timestamp},v1=aa` },
          body: "{}",
        }),
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: SIGNATURE_KEY_FAILURE_MESSAGE,
      });
    } finally {
      importKey.mockRestore();
    }
  });

  it("does not raise an unhandled rejection when the key import fails", async () => {
    const importKey = vi
      .spyOn(crypto.subtle, "importKey")
      .mockRejectedValue(new Error("crypto.subtle is not available"));
    const unhandled = vi.fn();

    process.on("unhandledRejection", unhandled);

    try {
      marketWithSecret().webhooks.handler();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      importKey.mockRestore();
    }
  });

  it("answers 500 when a provision handler returns nothing", async () => {
    const market = marketWithSecret();
    // A JavaScript seller reaches this with a handler the types would reject.
    market.on("provision", (() => undefined) as never);

    const response = await market.webhooks.handler()(
      await signTestEvent({
        secret: SECRET,
        event: { type: "provision", data: PROVISION },
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: HANDLER_FAILURE_MESSAGE,
    });
  });

  it("answers 500 when a provision result omits externalAccountId", async () => {
    const market = marketWithSecret();
    market.on("provision", (() => ({ created: true })) as never);

    const response = await market.webhooks.handler()(
      await signTestEvent({
        secret: SECRET,
        event: { type: "provision", data: PROVISION },
      }),
    );

    expect(response.status).toBe(500);
  });

  it("answers 500 when a provision result omits created", async () => {
    const market = marketWithSecret();
    market.on("provision", (() => ({ externalAccountId: "acct_1" })) as never);

    const response = await market.webhooks.handler()(
      await signTestEvent({
        secret: SECRET,
        event: { type: "provision", data: PROVISION },
      }),
    );

    expect(response.status).toBe(500);
  });

  it("answers a provision result with only the two declared fields", async () => {
    const market = marketWithSecret();
    market.on("provision", () => ({
      externalAccountId: "acct_1",
      created: false,
      internalToken: "secret",
    }));

    const response = await market.webhooks.handler()(
      await signTestEvent({
        secret: SECRET,
        event: { type: "provision", data: PROVISION },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      externalAccountId: "acct_1",
      created: false,
    });
  });
});
