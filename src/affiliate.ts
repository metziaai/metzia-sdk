import { z } from "zod";

import { ATTRIBUTION_WINDOW_MAX_DAYS } from "./catalog-fields";
import {
  MarketRequestError,
  MarketRetryError,
  MarketValidationError,
  type MarketValidationIssue,
} from "./errors";
import {
  bodyWaitSeconds,
  detailOf,
  envelopeIssues,
  readEnvelope,
  RETRIES,
  sendWithRetry,
  type Answered,
  type Send,
} from "./transport";

/**
 * The affiliate program surface.
 *
 * The platform's affiliate endpoint holds the contract this module speaks.
 *
 * `register()` validates the input first, so a term the rules refuse reaches no
 * network. It raises `MarketValidationError` for a field the SDK refuses and
 * for a field the platform refuses, so a caller reads one shape for both. That
 * is the convention `define()` follows.
 *
 * ## WARNING: new terms stop commission until staff approve them again
 *
 * An approved program pays commission. `register()` with a changed rate, term,
 * or template opens a new version that staff must approve, so commission stops
 * until they do. Call `get()` first, and call `register()` only when a term
 * really changes. Terms equal to the stored program write nothing and answer
 * `changed: false`.
 *
 * ## The retries
 *
 * Every method sends the call again after a network failure, up to three
 * times. That is safe for all three: `register()` with the same terms writes
 * nothing, `get()` writes nothing, and `disable()` on a program that already
 * ended changes nothing. No method carries an idempotency key, because none
 * needs one.
 *
 * WARNING: a retry after a lost answer can report `changed: false` for a change
 * the first attempt made. The first attempt wrote the version, and the second
 * one states the terms that now stand. Call `get()` to read the current terms.
 */
export const AFFILIATE_PATH = "/api/v1/affiliate";

/** The limit on the affiliate network's own program id. */
const PROGRAM_ID_LIMIT = 200;

/** The limit on the link template, in characters. */
const TEMPLATE_LIMIT = 2000;

/** The basis points one hundred percent is. One percent is 100. */
const RATE_MAX = 10_000;

/** The longest attribution window a program may declare. `catalog-fields.ts` states why. */
const WINDOW_MAX = ATTRIBUTION_WINDOW_MAX_DAYS;

/**
 * The sub identifier macro, in either case.
 *
 * The platform reads the macro without regard to case, so both `{SUBID}` and
 * `{subid}` are correct. The platform checks the same rule.
 */
const SUBID_MACRO = /\{subid\}/i;

/** A whitespace or control character. A URL template holds neither. */
// `Cf` holds the invisible format characters, for example a zero width space.
const BLANK_OR_CONTROL = /[\s\p{Cc}\p{Cf}]/u;

/** Every macro slot of the stored grammar, in either case. */
const ANY_MACRO = /\{(SUBID|DEST|CLICKID)\}/i;

/**
 * How long a commission follows a referred buyer.
 *
 * `life_of_account` pays on every invoice. `twelve_months` pays for twelve
 * months. `first_invoice` pays once.
 */
export const AFFILIATE_TERMS = ["life_of_account", "twelve_months", "first_invoice"] as const;

export type AffiliateTerm = (typeof AFFILIATE_TERMS)[number];

/**
 * The state of one program.
 *
 * `not_started`, `applied`, `approved`, `rejected`, and `terminated` are the
 * enrolment lifecycle of a program the platform still operates. `inactive`
 * means the platform suspended or ended the program, whatever its enrolment
 * says. Commission runs on `approved` and on no other value.
 */
export const AFFILIATE_PROGRAM_STATES = [
  "not_started",
  "applied",
  "approved",
  "rejected",
  "terminated",
  "inactive",
] as const;

export type AffiliateProgramState = (typeof AFFILIATE_PROGRAM_STATES)[number];

/** The terms one `register()` call states. */
export type AffiliateRegisterInput = {
  /** The program's own id at the affiliate network. */
  programId: string;
  /** Whole basis points. One percent is 100, so 2500 is 25 percent. */
  rate: number;
  term: AffiliateTerm;
  /** One absolute https URL that carries the placeholder {SUBID}. */
  linkTemplate: string;
  /** Whole days. The platform applies 30 when a first registration states none. */
  attributionWindowDays?: number;
};

/**
 * What one `register()` call did.
 *
 * WARNING: the two identifiers are different values. `programId` is the
 * platform's own id for the open version, which changes when a term changes.
 * `networkProgramId` is the identifier the call stated, which is the program's
 * own id at the affiliate network.
 */
export type AffiliateRegisterResult = {
  /** The platform's own id for the open program version. */
  readonly programId: string;
  /** The program's own id at the affiliate network, as the call stated it. */
  readonly networkProgramId: string;
  /** False when the stored terms already state this bargain, so nothing was written. */
  readonly changed: boolean;
  readonly status: AffiliateProgramState;
  /** True whenever the program is not approved, so commission does not run yet. */
  readonly approvalRequired: boolean;
};

/**
 * The stored program of the calling seller.
 *
 * WARNING: the two identifiers are different values. `programId` is the
 * platform's own id for the open version. `networkProgramId` is the program's
 * own id at the affiliate network, and it is null on a version that names none.
 */
export type AffiliateProgram = {
  /** The platform's own id for the open program version. */
  readonly programId: string;
  /** The program's own id at the affiliate network, or null. */
  readonly networkProgramId: string | null;
  /** Whole basis points, or null for a program that pays a fixed amount. */
  readonly rate: number | null;
  /** `other` names a stored month count this vocabulary cannot express. */
  readonly term: AffiliateTerm | "other";
  readonly linkTemplate: string;
  /** When staff approved the enrolment, as ISO text, or null until they do. */
  readonly confirmedAt: string | null;
  readonly status: AffiliateProgramState;
};

/** What one `disable()` call did. */
export type AffiliateDisableResult = {
  /** The program the call ended, or null when the seller held none. */
  readonly programId: string | null;
  /** False when no open program existed, so nothing was written. */
  readonly changed: boolean;
};

/** What one affiliate call takes beyond its terms. */
export type AffiliateOptions = {
  /**
   * Stops the call, and every retry of it.
   *
   * The signal reaches `fetch`, and it ends a wait between two attempts at
   * once. An abort raises the reason of the signal, which is the `AbortError`
   * of the platform by default. The SDK raises no error of its own here,
   * because the caller already holds the reason it named.
   *
   * An abort stops the retries. The platform may hold the version of a call
   * that already landed, so read it with `get()` before you register again.
   */
  signal?: AbortSignal;
};

export type AffiliateSurface = {
  register(
    input: AffiliateRegisterInput,
    options?: AffiliateOptions,
  ): Promise<AffiliateRegisterResult>;
  get(options?: AffiliateOptions): Promise<AffiliateProgram | null>;
  disable(options?: AffiliateOptions): Promise<AffiliateDisableResult>;
};

/**
 * The link template rule, stated once.
 *
 * The platform holds the same rule, so a template this schema accepts is one
 * the server accepts.
 */
export const linkTemplateSchema: z.ZodType<string> = z
  .string()
  .trim()
  .min(1)
  .max(TEMPLATE_LIMIT)
  .refine((value) => !BLANK_OR_CONTROL.test(value), {
    error: "The link template must hold no space and no control character.",
  })
  .refine((value) => isAbsoluteHttpsUrl(value), {
    error: "The link template must be one absolute https URL.",
  })
  .refine((value) => SUBID_MACRO.test(value), {
    error: "The link template must carry the placeholder {SUBID} at least once.",
  })
  .refine((value) => !holdsMacroInFragment(value), {
    error: "The link template must carry no placeholder after the fragment mark #.",
  });

/**
 * True when a link macro stands after the first `#`.
 *
 * The platform refuses such a template at the register and at every click. One
 * macro position must take one encoding, and a fragment takes another.
 */
function holdsMacroInFragment(template: string): boolean {
  const hashAt = template.indexOf("#");

  if (hashAt === -1) return false;

  return ANY_MACRO.test(template.slice(hashAt));
}

export const registerSchema = z
  .object({
    programId: z.string().trim().min(1).max(PROGRAM_ID_LIMIT),
    rate: z
      .int({ error: "State the rate as whole basis points. One percent is 100." })
      .min(1)
      .max(RATE_MAX),
    term: z.enum(AFFILIATE_TERMS),
    linkTemplate: linkTemplateSchema,
    attributionWindowDays: z.int().min(1).max(WINDOW_MAX).optional(),
  })
  .strict();

const programStateSchema = z.enum(AFFILIATE_PROGRAM_STATES);

const registerAnswerSchema = z.object({
  program: z.object({
    id: z.string().min(1),
    networkProgramId: z.string().min(1),
    changed: z.boolean(),
    status: programStateSchema,
    approvalRequired: z.boolean(),
  }),
});

const readAnswerSchema = z.object({
  program: z
    .object({
      id: z.string().min(1),
      networkProgramId: z.string().nullable(),
      rate: z.number().int().nullable(),
      term: z.union([z.enum(AFFILIATE_TERMS), z.literal("other")]),
      linkTemplate: z.string(),
      confirmedAt: z.string().nullable(),
      status: programStateSchema,
    })
    .nullable(),
});

const disableAnswerSchema = z.object({
  program: z.object({ id: z.string().min(1).nullable(), changed: z.boolean() }),
});

/** True for an absolute https URL. The platform stores the literal it reads. */
function isAbsoluteHttpsUrl(value: string): boolean {
  if (!value.startsWith("https://")) return false;

  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validates the input and registers the terms.
 *
 * The validation runs first and raises `MarketValidationError` before any
 * network call, so terms the rules refuse cost the seller no request.
 *
 * WARNING: a retry after a lost answer can report `changed: false` for a change
 * this call made. Read the current terms with `get()`.
 */
export async function registerProgram(
  send: Send,
  input: AffiliateRegisterInput,
  options?: AffiliateOptions,
): Promise<AffiliateRegisterResult> {
  const parsed = registerSchema.safeParse(input);

  if (!parsed.success) throw new MarketValidationError(localIssues(parsed.error.issues));

  const result = await sendCall(
    send,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed.data),
      signal: options?.signal,
    },
    options,
  );

  const program = read(result, registerAnswerSchema, "register").program;

  return {
    programId: program.id,
    networkProgramId: program.networkProgramId,
    changed: program.changed,
    status: program.status,
    approvalRequired: program.approvalRequired,
  };
}

/** Reads the calling seller's program, or null when it holds none. */
export async function readProgram(
  send: Send,
  options?: AffiliateOptions,
): Promise<AffiliateProgram | null> {
  const result = await sendCall(send, { method: "GET", signal: options?.signal }, options);
  const program = read(result, readAnswerSchema, "read").program;

  if (program === null) return null;

  return {
    programId: program.id,
    networkProgramId: program.networkProgramId,
    rate: program.rate,
    term: program.term,
    linkTemplate: program.linkTemplate,
    confirmedAt: program.confirmedAt,
    status: program.status,
  };
}

/** Ends the calling seller's program. A second call changes nothing. */
export async function disableProgram(
  send: Send,
  options?: AffiliateOptions,
): Promise<AffiliateDisableResult> {
  const result = await sendCall(send, { method: "DELETE", signal: options?.signal }, options);
  const program = read(result, disableAnswerSchema, "disable").program;

  return { programId: program.id, changed: program.changed };
}

/**
 * Sends one call through the shared retry loop.
 *
 * A network failure never delivered an answer. Every method of this module is
 * safe to repeat, so the loop sends the call again up to three times. It waits
 * for no answer, because this route names no in flight attempt.
 */
function sendCall(
  send: Send,
  init: RequestInit,
  options: AffiliateOptions | undefined,
): Promise<Answered> {
  return sendWithRetry(send, AFFILIATE_PATH, init, {
    signal: options?.signal,
    exhausted: (cause) =>
      new MarketRequestError(
        `The affiliate call did not reach the platform in ${RETRIES + 1} attempts, and the outcome is unknown. Read the program with GET ${AFFILIATE_PATH}, then call again.`,
        { cause },
      ),
  });
}

/**
 * Turns one answer into the value the method returns, or into the error that
 * names the refusal.
 *
 * A 422 is a field refusal, so it raises `MarketValidationError` with the
 * platform's own field names. A 409 `conflict`, a 429, and every 5xx raise
 * `MarketRetryError`, because the caller decides when to call again. Every
 * other status raises `MarketRequestError`.
 *
 * A 409 is retryable on this route alone when the code is `conflict`, which
 * names two lost races on the row. Every other 409 names a stored state that
 * only staff or an operator repairs, so a retry would refuse again.
 */
function read<T>(result: Answered, schema: z.ZodType<T>, action: string): T {
  if (result.ok) {
    const parsed = schema.safeParse(result.body);
    if (parsed.success) return parsed.data;

    throw new MarketRequestError(
      `The platform accepted the affiliate ${action} with status ${result.status} and the SDK cannot read the answer. Read the program with GET ${AFFILIATE_PATH}, and update the SDK.`,
      { status: result.status },
    );
  }

  if (result.code === "body") {
    throw new MarketRequestError(
      `The platform answered ${result.status} with a body that is not JSON. Read the program with GET ${AFFILIATE_PATH}.`,
      { status: result.status },
    );
  }

  const envelope = readEnvelope(result.body);
  const detail = envelope?.message ?? detailOf(result.body);

  if (result.status === 422) throw new MarketValidationError(envelopeIssues(envelope));

  if (result.status === 409 && envelope?.code === "conflict") {
    throw new MarketRetryError(result.status, bodyWaitSeconds(envelope), detail);
  }

  if (result.status === 429 || result.status >= 500) {
    throw new MarketRetryError(
      result.status,
      result.retryAfterSeconds ?? bodyWaitSeconds(envelope),
      detail,
    );
  }

  throw new MarketRequestError(
    `The platform refused the affiliate ${action} with status ${result.status} and nothing was written. The platform said: ${detail}`,
    { status: result.status, code: envelope?.code },
  );
}

/** One issue per field the local schema refused. */
function localIssues(
  issues: readonly { path: readonly PropertyKey[]; code: string; message: string }[],
): readonly MarketValidationIssue[] {
  return issues.map((issue) => ({
    field: issue.path.length === 0 ? "body" : issue.path.map(String).join("."),
    rule: issue.code,
    message: issue.message,
  }));
}

