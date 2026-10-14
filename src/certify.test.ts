import { describe, expect, it } from "vitest";

import { CERTIFICATION_CHECKS, runCertification } from "./certify";
import { Market } from "./market";

const SECRET = "whsec_certify_test";
const URL_ = "https://seller.example.test/metzia-webhooks";

/** A receiver built with the SDK itself, with the provision handler the case names. */
function receiver(provision: (event: { orderId: string }) => { externalAccountId: string; created: boolean }) {
  const market = new Market("osk_sel_TESTKEY", { baseUrl: "https://api.example.test", webhookSecret: SECRET });
  market.on("provision", async (event) => provision(event));
  market.on("cancel", async () => undefined);
  const handler = market.webhooks.handler();
  return (request: Request) => handler(request);
}

/** An upsert on the order: the second call links the account the first created. */
function idempotent() {
  const accounts = new Map<string, string>();
  return receiver(({ orderId }) => {
    const existing = accounts.get(orderId);
    if (existing !== undefined) return { externalAccountId: existing, created: false };
    const id = `acct_${accounts.size + 1}`;
    accounts.set(orderId, id);
    return { externalAccountId: id, created: true };
  });
}

function run(fetch: (request: Request) => Promise<Response>) {
  return runCertification({ url: URL_, secret: SECRET, sku: "crm-pro", runId: "run-1", fetch });
}

describe("runCertification", () => {
  it("passes every check against a handler that upserts on the order", async () => {
    const result = await run(idempotent());

    expect(result.passed).toBe(true);
    expect(result.checks.map((check) => [check.name, check.passed])).toEqual(
      CERTIFICATION_CHECKS.map((name) => [name, true]),
    );
  });

  it("fails the idempotency check, and names it, for a handler that creates an account on every call", async () => {
    let count = 0;
    const result = await run(
      receiver(() => {
        count += 1;
        return { externalAccountId: `acct_${count}`, created: true };
      }),
    );

    expect(result.passed).toBe(false);
    const check = result.checks.find((item) => item.name === "provision_is_idempotent");
    expect(check?.passed).toBe(false);
    expect(check?.detail).toContain("created the account acct_2, not acct_1");
  });

  it("fails the idempotency check for a retry that links the account but answers created: true", async () => {
    const result = await run(receiver(() => ({ externalAccountId: "acct_1", created: true })));

    expect(result.checks.find((item) => item.name === "provision_is_idempotent")).toMatchObject({
      passed: false,
      detail: expect.stringContaining("created: false"),
    });
  });

  it("fails the signature check for a receiver that accepts a bad signature", async () => {
    const good = idempotent();
    const result = await run(async (request) => {
      // A receiver that skips verification: it answers every call as the good one would with a valid signature.
      if (request.headers.get("Metzia-Signature")?.includes("v1=")) {
        const response = await good(request);
        return response.status === 401 ? new Response(JSON.stringify({ externalAccountId: "acct_1", created: false }), { status: 200 }) : response;
      }
      return good(request);
    });

    expect(result.checks.find((item) => item.name === "bad_signature_refused")?.passed).toBe(false);
  });

  it("fails every check with the reason when the receiver cannot be reached", async () => {
    const result = await run(async () => {
      throw new TypeError("fetch failed");
    });

    expect(result.passed).toBe(false);
    expect(result.checks.every((check) => !check.passed)).toBe(true);
    expect(result.checks[0]?.detail).toContain("could not be reached: fetch failed");
    expect(result.checks.find((item) => item.name === "cancel_answers")?.detail).toContain("no cancel was sent");
  });

  it("names a test buyer and a test order of the run in the provision", async () => {
    const seen: unknown[] = [];
    const good = idempotent();
    await run(async (request) => {
      seen.push(await request.clone().json());
      return good(request);
    });

    expect(seen[0]).toEqual({
      type: "provision",
      data: { buyerId: "certify-buyer-run-1", sku: "crm-pro", orderId: "certify-order-run-1" },
    });
  });

  it("gives up on a receiver that never answers and fails each check", async () => {
    // The fake receiver answers only when the request signal aborts, as fetch does.
    const silent = (request: Request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });

    const result = await runCertification({
      url: URL_,
      secret: SECRET,
      sku: "crm-pro",
      runId: "run-1",
      fetch: silent,
      timeoutMs: 20,
    });

    expect(result.passed).toBe(false);
    expect(result.checks.every((check) => !check.passed)).toBe(true);
    expect(result.checks[0]?.detail).toContain("could not be reached");
  });
});
