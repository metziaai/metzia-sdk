import { signTestEvent } from "./testing";
import type { ProvisionEvent } from "./events";
import type { WebhookEnvelope } from "./webhooks";

/**
 * The seller certification run.
 *
 * `market certify` sends the seller's webhook receiver the calls the platform
 * sends, signed the way the platform signs them, and checks each answer. It
 * proves the handler is idempotent: a provision retried with the same order
 * must link the account it already created, because the platform sends a
 * callback again when the receiver loses the answer.
 *
 * The run reads no Node API. It takes `fetch` and a run id from the caller,
 * so a test drives it with an in process receiver. `src/cli.ts` reads the
 * flags and the environment, and `bin/market.mjs` wires both to the process.
 *
 * Run this against a seller sandbox as a dry run. The events name a
 * test buyer and a test order, so a seller can recognise and remove what the
 * run created.
 */

/** Every check, in the order the run makes it. */
export const CERTIFICATION_CHECKS = [
  "provision_answers",
  "provision_is_idempotent",
  "cancel_answers",
  "bad_signature_refused",
] as const;

export type CertificationCheckName = (typeof CERTIFICATION_CHECKS)[number];

export type CertificationCheck = {
  readonly name: CertificationCheckName;
  readonly passed: boolean;
  /** One sentence a seller acts on. */
  readonly detail: string;
};

export type CertificationResult = {
  readonly passed: boolean;
  readonly checks: readonly CertificationCheck[];
};

export type CertifyInput = {
  /** The seller's webhook receiver. */
  readonly url: string;
  /** The webhook signing secret the receiver was configured with. */
  readonly secret: string;
  /** A sku the seller's provision handler knows. */
  readonly sku: string;
  /** Names the test buyer and the test order of this run. */
  readonly runId: string;
  readonly fetch: (request: Request) => Promise<Response>;
  /** The longest one receiver call may take. The default is `RECEIVER_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
};

/**
 * The longest one receiver call may take, from the request to the last byte of
 * the body. Without it a receiver that never answers holds the command open
 * until the socket closes. A call past it counts as unreachable.
 */
export const RECEIVER_TIMEOUT_MS = 10_000;

type Answer =
  | { readonly kind: "response"; readonly status: number; readonly body: unknown }
  | { readonly kind: "unreachable"; readonly reason: string };

async function send(input: CertifyInput, event: WebhookEnvelope, secret: string = input.secret): Promise<Answer> {
  const signed = await signTestEvent({ secret, event, url: input.url });
  const request = new Request(signed, { signal: AbortSignal.timeout(input.timeoutMs ?? RECEIVER_TIMEOUT_MS) });
  let response: Response;
  try {
    response = await input.fetch(request);
  } catch (error) {
    return { kind: "unreachable", reason: error instanceof Error ? error.message : String(error) };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { kind: "response", status: response.status, body };
}

/** The account a provision answer names, or null when the answer is not one. */
function accountOf(body: unknown): { readonly externalAccountId: string; readonly created: boolean } | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.externalAccountId !== "string" || record.externalAccountId === "") return null;
  if (typeof record.created !== "boolean") return null;
  return { externalAccountId: record.externalAccountId, created: record.created };
}

function describe(answer: Answer): string {
  return answer.kind === "unreachable"
    ? `The receiver could not be reached: ${answer.reason}.`
    : `The receiver answered HTTP ${answer.status}.`;
}

/**
 * Runs every check once and answers each result. A check that cannot run
 * because an earlier one failed fails too, and says why.
 */
export async function runCertification(input: CertifyInput): Promise<CertificationResult> {
  const provision: ProvisionEvent = {
    buyerId: `certify-buyer-${input.runId}`,
    sku: input.sku,
    orderId: `certify-order-${input.runId}`,
  };
  const checks: CertificationCheck[] = [];

  const first = await send(input, { type: "provision", data: provision });
  const firstAccount = first.kind === "response" && first.status === 200 ? accountOf(first.body) : null;
  checks.push(
    firstAccount === null
      ? {
          name: "provision_answers",
          passed: false,
          detail: `${describe(first)} A provision must answer HTTP 200 with externalAccountId and created.`,
        }
      : {
          name: "provision_answers",
          passed: true,
          detail: `The receiver answered the account ${firstAccount.externalAccountId}.`,
        },
  );

  const second = await send(input, { type: "provision", data: provision });
  const secondAccount = second.kind === "response" && second.status === 200 ? accountOf(second.body) : null;
  if (firstAccount === null || secondAccount === null) {
    checks.push({
      name: "provision_is_idempotent",
      passed: false,
      detail: `${describe(second)} The retried provision gave no account to compare.`,
    });
  } else if (secondAccount.externalAccountId !== firstAccount.externalAccountId) {
    checks.push({
      name: "provision_is_idempotent",
      passed: false,
      detail: `The retried provision created the account ${secondAccount.externalAccountId}, not ${firstAccount.externalAccountId}. Upsert on the order, so a retry links the account it already created.`,
    });
  } else if (secondAccount.created) {
    checks.push({
      name: "provision_is_idempotent",
      passed: false,
      detail: "The retried provision answered created: true. A retry that links an existing account answers created: false.",
    });
  } else {
    checks.push({
      name: "provision_is_idempotent",
      passed: true,
      detail: "The retried provision linked the same account and answered created: false.",
    });
  }

  if (firstAccount === null) {
    checks.push({ name: "cancel_answers", passed: false, detail: "No account came back, so no cancel was sent." });
  } else {
    const cancel = await send(input, {
      type: "cancel",
      data: { externalAccountId: firstAccount.externalAccountId, sku: input.sku },
    });
    const passed = cancel.kind === "response" && cancel.status >= 200 && cancel.status < 300;
    checks.push({
      name: "cancel_answers",
      passed,
      detail: passed ? "The receiver accepted the cancel." : `${describe(cancel)} A cancel must answer HTTP 2xx.`,
    });
  }

  const forged = await send(input, { type: "provision", data: provision }, `${input.secret}-not-the-secret`);
  const refused = forged.kind === "response" && forged.status === 401;
  checks.push({
    name: "bad_signature_refused",
    passed: refused,
    detail: refused
      ? "The receiver refused a call with a bad signature."
      : `${describe(forged)} A call with a bad signature must answer HTTP 401.`,
  });

  return { passed: checks.every((check) => check.passed), checks };
}
