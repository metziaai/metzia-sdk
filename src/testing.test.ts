import { describe, expect, it } from "vitest";

import { Market } from "./market";
import type { ProvisionEvent } from "./events";
import {
  DEFAULT_TEST_URL,
  MISSING_TEST_SECRET_MESSAGE,
  signTestEvent,
} from "./testing";
import {
  MISSING_WEBHOOK_SECRET_MESSAGE,
  SIGNATURE_HEADER,
  parseSignatureHeader,
} from "./webhooks";

const SECRET = "test-webhook-secret";

const PROVISION: ProvisionEvent = {
  buyerId: "byr_a9f3",
  sku: "pro",
  orderId: "ord_123",
};

describe("signTestEvent", () => {
  it("builds a POST Request to the default URL", async () => {
    const request = await signTestEvent({
      secret: SECRET,
      event: { type: "provision", data: PROVISION },
    });

    expect(request.url).toBe(DEFAULT_TEST_URL);
    expect(request.method).toBe("POST");
  });

  it("honors a caller URL", async () => {
    const request = await signTestEvent({
      secret: SECRET,
      event: { type: "provision", data: PROVISION },
      url: "http://localhost:3000/webhooks",
    });

    expect(request.url).toBe("http://localhost:3000/webhooks");
  });

  it("writes the versioned signature header", async () => {
    const request = await signTestEvent({
      secret: SECRET,
      event: { type: "provision", data: PROVISION },
      timestamp: 1_700_000_000,
    });

    const parsed = parseSignatureHeader(request.headers.get(SIGNATURE_HEADER));

    expect(parsed).toBeDefined();
    expect(parsed?.timestamp).toBe("1700000000");
    expect(parsed?.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("serializes the exact envelope as the body", async () => {
    const event = { type: "cancel" as const, data: { externalAccountId: "a", sku: "pro" } };
    const request = await signTestEvent({ secret: SECRET, event });

    expect(await request.text()).toBe(JSON.stringify(event));
  });

  it("uses the caller timestamp for a deterministic signature", async () => {
    const input = {
      secret: SECRET,
      event: { type: "provision" as const, data: PROVISION },
      timestamp: 1_700_000_000,
    };

    const first = await signTestEvent(input);
    const second = await signTestEvent(input);

    expect(first.headers.get(SIGNATURE_HEADER)).toBe(
      second.headers.get(SIGNATURE_HEADER),
    );
  });

  it("rejects an empty secret without building a request", async () => {
    await expect(
      signTestEvent({
        secret: "   ",
        event: { type: "provision", data: PROVISION },
      }),
    ).rejects.toThrow(MISSING_TEST_SECRET_MESSAGE);
  });

  it("signs a body the receiver accepts", async () => {
    const market = new Market("test-key", { webhookSecret: SECRET });
    market.on("provision", (event) => ({
      externalAccountId: `acme_${event.buyerId}`,
      created: true,
    }));

    const response = await market.webhooks.handler()(
      await signTestEvent({
        secret: SECRET,
        event: { type: "provision", data: PROVISION },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      externalAccountId: "acme_byr_a9f3",
      created: true,
    });
  });

  it("does not need the receiver secret to throw for a wrong one", async () => {
    const market = new Market("test-key", { webhookSecret: "right-secret" });

    const response = await market.webhooks.handler()(
      await signTestEvent({
        secret: "wrong-secret",
        event: { type: "provision", data: PROVISION },
      }),
    );

    expect(response.status).toBe(401);
  });

  it("names the receiver setup error, not the signer's", () => {
    const market = new Market("test-key");

    expect(() => market.webhooks.handler()).toThrow(
      MISSING_WEBHOOK_SECRET_MESSAGE,
    );
  });
});
