import { z } from "zod";

import {
  BILLING_INTERVALS,
  DELIVERS,
  LIMIT_KEY_PATTERN,
  LISTING_COUNT_LIMITS,
  PRICE_INTERVALS,
  PRICE_POINT_TEXT_LIMITS,
  PRICING_MODELS,
  PRODUCT_TEXT_LIMITS,
  PROVISIONING_TIERS,
  RENEWAL_BEHAVIOURS,
  SLUG_PATTERN,
  SUBSCRIPTION_LIMITS,
} from "./catalog-fields";
import { MarketValidationError, type MarketValidationIssue } from "./errors";

const {
  identifier: IDENTIFIER_LIMIT,
  pricePoints: PRICE_POINT_LIMIT,
  terms: TERM_LIMIT,
} = LISTING_COUNT_LIMITS;

const nonNegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const pricePointSchema = z
  .object({
    amountMicros: nonNegativeInteger,
    unitName: z.string().trim().min(1).max(PRICE_POINT_TEXT_LIMITS.unitName),
    interval: z.enum(PRICE_INTERVALS).nullable().default(null),
    plan: z.string().trim().min(1).max(PRICE_POINT_TEXT_LIMITS.plan).nullable().default(null),
    tierMin: nonNegativeInteger.nullable().default(null),
    tierMax: nonNegativeInteger.nullable().default(null),
  })
  .strict();

/**
 * The product destination path rule, mirrored from the publish contract.
 *
 * This package keeps its own copy on purpose: it holds no dependency on the
 * application, and the rule is structural. The path is relative to the
 * seller's own site, starts with one slash, holds no backslash, and holds no
 * `.` or `..` segment in the value or in any form it decodes to. The server
 * runs the same rule again and is the control.
 */
const MAX_DECODES = 3;

function isDestinationPath(value: string): boolean {
  if (!value.startsWith("/")) return false;

  for (const form of decodedForms(value)) {
    if (form.startsWith("//")) return false;
    if (form.includes("\\")) return false;
  }

  for (const segment of value.split("/")) {
    for (const form of decodedForms(segment)) {
      for (const piece of form.split("/")) {
        if (piece === "." || piece === "..") return false;
      }
    }
  }

  return true;
}

/** One text and every form it decodes to, at most `MAX_DECODES` rounds. */
function decodedForms(text: string): readonly string[] {
  const forms = [text];
  let current = text;

  for (let round = 0; round < MAX_DECODES; round += 1) {
    let next: string;

    try {
      next = decodeURIComponent(current);
    } catch {
      break;
    }

    if (next === current) break;
    forms.push(next);
    current = next;
  }

  return forms;
}

const destinationPathSchema = z.string().refine(isDestinationPath, {
  error:
    "A destination path starts with one slash and holds no backslash or dot segment. Write the product page path, for example /products/example.",
});

/** The number of code points in a value, the way Postgres `char_length` counts. */
function codePoints(value: string): number {
  return [...value].length;
}

/**
 * The subscription terms, in the shape the server parses.
 *
 * The host rule is not here. It compares the cancellation URL with the stored
 * seller website domain, which only the server holds. The SDK checks what a
 * caller can fix without the platform: one absolute https address that carries
 * no credentials.
 */
const subscriptionSchema = z
  .object({
    billingInterval: z.enum(BILLING_INTERVALS),
    renewalBehaviour: z.enum(RENEWAL_BEHAVIOURS),
    cancellationUrl: z.string().min(1).max(SUBSCRIPTION_LIMITS.cancellationUrl),
    freeTrialDays: z
      .number()
      .int()
      .min(0)
      .max(SUBSCRIPTION_LIMITS.freeTrialDaysMax)
      .nullable()
      .default(null),
    renewalTerms: z
      .string()
      .refine(
        (value) =>
          codePoints(value) >= SUBSCRIPTION_LIMITS.renewalTermsMin &&
          codePoints(value) <= SUBSCRIPTION_LIMITS.renewalTerms,
        `Enter ${SUBSCRIPTION_LIMITS.renewalTermsMin} to ${SUBSCRIPTION_LIMITS.renewalTerms} characters.`,
      )
      .nullable()
      .default(null),
  })
  .strict();

/**
 * The limits of one listing. The publish API takes a whole number or a
 * boolean, and the vocabulary's `value_type` for the key decides which. The
 * key must hold the limit key rule and a listing names at most `TERM_LIMIT`
 * keys, or the API answers 422 for a listing this check let through.
 */
export const limitsSchema = z
  .record(
    z
      .string()
      .regex(
        LIMIT_KEY_PATTERN,
        "A limit key is a vocabulary key: lower case letters, digits, and underscores, starting with a letter.",
      ),
    z.union([nonNegativeInteger, z.boolean()]),
  )
  .refine((limits) => Object.keys(limits).length <= TERM_LIMIT, {
    error: `A listing names at most ${TERM_LIMIT} limits.`,
    params: { rule: "max" },
  })
  .default({});

const listingObject = z
  .object({
    sku: z.string().trim().min(1).max(IDENTIFIER_LIMIT),
    name: z.string().trim().min(1).max(IDENTIFIER_LIMIT),
    categorySlug: z.string().regex(SLUG_PATTERN),
    pricingModel: z.enum(PRICING_MODELS),
    delivers: z.enum(DELIVERS),
    provisioning: z.enum(PROVISIONING_TIERS),
    summary: z.string().trim().min(1).max(PRODUCT_TEXT_LIMITS.summary),
    description: z
      .string()
      .trim()
      .max(PRODUCT_TEXT_LIMITS.description)
      .nullable()
      .default(null),
    notAFitWhen: z
      .string()
      .trim()
      .min(PRODUCT_TEXT_LIMITS.notAFitWhenMin)
      .max(PRODUCT_TEXT_LIMITS.notAFitWhen),
    destinationPath: destinationPathSchema,
    pricePoints: z.array(pricePointSchema).min(1).max(PRICE_POINT_LIMIT),
    limits: limitsSchema,
    integrations: z.array(z.string().regex(SLUG_PATTERN)).max(TERM_LIMIT).default([]),
    isSubscription: z.boolean().default(false),
    subscription: subscriptionSchema.nullable().default(null),
  })
  .strict();

/** The strict SDK listing schema. Its field names are the publish API wire names. */
export const listingSchema = listingObject.superRefine((listing, context) => {
  const points = listing.pricePoints;

  if (listing.pricingModel !== "tiered") {
    points.forEach((point, position) => {
      if (point.tierMin !== null || point.tierMax !== null) {
        addRule(context, ["pricePoints", position], "enum", "Tier bounds require tiered pricing.");
      }
    });
  } else {
    const last = points.length - 1;
    const bands: { readonly position: number; readonly min: number; readonly max: number | null }[] = [];
    const broken = new Set<number>();

    points.forEach((point, position) => {
      if (point.tierMin === null) {
        broken.add(position);
        return;
      }
      if (point.tierMax === null && position !== last) broken.add(position);
      if (point.tierMax !== null && point.tierMin >= point.tierMax) broken.add(position);
      bands.push({ position, min: point.tierMin, max: point.tierMax });
    });

    bands.sort((left, right) => left.min - right.min);
    let expected = bands[0]?.max ?? null;
    for (let index = 1; index < bands.length; index += 1) {
      const band = bands[index];
      if (expected !== null && band.min !== expected) broken.add(band.position);
      if (expected !== null && band.max !== null && band.max > expected) expected = band.max;
      if (band.max === null) expected = null;
    }

    for (const position of [...broken].sort((left, right) => left - right)) {
      addRule(
        context,
        ["pricePoints", position],
        "min",
        "A tiered price point must form one ordered, contiguous tier.",
      );
    }
  }

  if (listing.pricingModel !== "tiered" && points.length > 1) {
    points.forEach((point, position) => {
      if (point.plan === null) {
        addRule(context, ["pricePoints", position, "plan"], "required", "A plan is required when a listing has several prices.");
      }
    });
  }

  // The subscription rules that need no platform data. The server repeats
  // them and adds the host comparison.
  const recurring = points.some((point) => point.interval === "month" || point.interval === "year");

  if (listing.isSubscription) {
    const terms = listing.subscription;

    if (terms === null) {
      for (const field of ["billingInterval", "renewalBehaviour", "cancellationUrl"]) {
        addRule(context, ["subscription", field], "required", "A subscription states this term.");
      }
    } else {
      if (cancellationUrlShape(terms.cancellationUrl) !== null) {
        addRule(
          context,
          ["subscription", "cancellationUrl"],
          "url",
          "A cancellation URL is one absolute https address on the seller's own site, with no credentials.",
        );
      }

      const needed =
        terms.billingInterval === "monthly"
          ? "month"
          : terms.billingInterval === "annual"
            ? "year"
            : null;

      if (needed !== null && !points.some((point) => point.interval === needed)) {
        addRule(
          context,
          ["subscription", "billingInterval"],
          "enum",
          `The billing interval says ${terms.billingInterval} and no price point charges every ${needed}.`,
        );
      }

      if (terms.renewalBehaviour === "one_time" && recurring) {
        addRule(
          context,
          ["subscription", "renewalBehaviour"],
          "enum",
          "A price point charges every month or every year, so the renewal behaviour is not one_time.",
        );
      }
    }
  } else {
    if (listing.subscription !== null) {
      addRule(
        context,
        ["subscription"],
        "enum",
        "Subscription terms need isSubscription true.",
      );
    }

    if (recurring) {
      addRule(
        context,
        ["isSubscription"],
        "required",
        "A price point charges every month or every year, so this listing is a subscription.",
      );
    }
  }

  const plans = new Map<string, number>();
  points.forEach((point, position) => {
    if (point.plan === null) return;
    const folded = point.plan.toLowerCase();
    const earlier = plans.get(folded);
    if (earlier === undefined) plans.set(folded, position);
    else addRule(context, ["pricePoints", position, "plan"], "enum", "Plan names must be unique, regardless of case.");
  });
});

/**
 * Why the cancellation URL is not one absolute https address, or null.
 *
 * The server repeats this rule and adds the host comparison it alone can make.
 */
function cancellationUrlShape(value: string): string | null {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return "A cancellation URL is one absolute https address.";
  }

  // The raw prefix and never `url.protocol`. The server stores the raw string
  // and its column check is `cancellation_url like 'https://%'`, which refuses
  // `HTTPS://x` although `url.protocol` reads `https:`.
  if (!value.startsWith("https://")) return "A cancellation URL uses https.";
  // An allow list, the same one the server holds. A refuse list lost twice to
  // the character classes of the database check.
  if (!/^[\u0021-\u007e]+$/.test(value)) {
    return "A cancellation URL holds printable ASCII characters only. Percent encode any other character in the path, and write an international host in its xn-- form.";
  }
  if (url.username !== "" || url.password !== "") {
    return "A cancellation URL carries no credentials.";
  }

  return null;
}

/** What a caller may pass. Defaults are optional in this input type. */
export type ListingInput = z.input<typeof listingSchema>;

/** The validated listing shape returned to a caller. */
export type Listing = z.output<typeof listingSchema>;

/**
 * Validates locally and returns the parsed listing. No network request is made.
 * Every Zod issue is preserved as a stable dotted-path SDK error.
 */
export function validateListing(input: unknown): Listing {
  const parsed = listingSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  throw new MarketValidationError(parsed.error.issues.flatMap(validationIssues));
}

function addRule(
  context: z.RefinementCtx,
  path: PropertyKey[],
  rule: string,
  message: string,
): void {
  context.addIssue({ code: "custom", path, message, params: { rule } });
}

function validationIssues(issue: z.core.$ZodIssue): MarketValidationIssue[] {
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => ({
      field: fieldPath([...issue.path, key]),
      rule: "unknown",
      message: `The field ${key} is not recognized.`,
    }));
  }

  if (issue.code === "invalid_key") {
    // A record key that fails its rule. The inner issue carries the rule's own
    // message, which names what a key may hold.
    const inner = issue.issues[0];
    return [
      {
        field: fieldPath(issue.path),
        rule: "format",
        message: inner?.message ?? issue.message,
      },
    ];
  }

  if (issue.code === "invalid_union") {
    // A limit value is a whole number or a boolean. Zod answers a union with
    // one issue list per branch, so the branch that came closest names the
    // fault: `2.5` reads as `integer` and `-1` as `min`, not as a bare union.
    const closest = closestBranch(issue.errors);
    if (closest !== undefined) {
      return [{ field: fieldPath(issue.path), rule: issueRule(closest), message: closest.message }];
    }
  }

  return [{ field: fieldPath(issue.path), rule: issueRule(issue), message: issue.message }];
}

/**
 * The first issue of the union branch that got furthest. A branch whose first
 * issue is a plain type mismatch never matched at all, so it is the last
 * choice. A value that matches no branch falls back to the first branch.
 */
function closestBranch(
  branches: readonly (readonly z.core.$ZodIssue[])[],
): z.core.$ZodIssue | undefined {
  const matched = branches.find((branch) => {
    const first = branch[0];
    return first !== undefined && !(first.code === "invalid_type" && first.expected !== "int");
  });
  return (matched ?? branches[0])?.[0];
}

function fieldPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "listing" : path.map(String).join(".");
}

function issueRule(issue: z.core.$ZodIssue): string {
  if (issue.code === "custom") {
    const rule = (issue.params as { readonly rule?: unknown } | undefined)?.rule;
    return typeof rule === "string" ? rule : "invalid";
  }
  if (issue.code === "invalid_value") return "enum";
  if (issue.code === "invalid_format") return "format";
  if (issue.code === "too_small") return issue.origin === "string" ? "too_short" : "min";
  if (issue.code === "too_big") return "max";
  if (issue.code === "invalid_type") {
    if (issue.message.includes("received undefined")) return "required";
    if (issue.expected === "int" || issue.message.includes("received NaN")) return "integer";
    return "type";
  }
  return "invalid";
}
