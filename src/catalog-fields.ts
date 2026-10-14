/**
 * Catalog wire constants shared by the SDK and the server.
 *
 * This module deliberately has no imports. The application imports this source
 * file directly, so the constants cannot drift before the SDK package is built.
 */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A limit key is an identifier, because a product limit row carries it by name.
 * The platform checks the same rule, so the publish API and the SDK's local
 * check agree.
 */
export const LIMIT_KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

export const PRICING_MODELS = ["flat", "seat", "usage", "tiered"] as const;

export const DELIVERS = [
  "seats",
  "credits",
  "api_key",
  "license",
  "access",
  "shipment",
] as const;

export const PROVISIONING_TIERS = ["delegated", "keyless", "claim"] as const;

export const PRICE_INTERVALS = ["month", "year"] as const;

export const PRICE_POINT_TEXT_LIMITS = {
  plan: 80,
  unitName: 40,
} as const;

/**
 * How often a subscription charges. `other` covers a period the two named
 * values do not, for example a quarter, and the renewal terms say which.
 */
export const BILLING_INTERVALS = ["monthly", "annual", "other"] as const;

/** What happens at the end of a billing period. */
export const RENEWAL_BEHAVIOURS = ["auto_renews", "manual_renewal", "one_time"] as const;

/**
 * The bounds of the subscription term fields.
 *
 * The platform checks the same numbers. The two text bounds count code points, because `char_length` counts code points.
 */
export const SUBSCRIPTION_LIMITS = {
  cancellationUrl: 2048,
  freeTrialDaysMax: 365,
  renewalTermsMin: 40,
  renewalTerms: 600,
} as const;

/**
 * The count bounds of one listing. `identifier` caps the sku and the name, as
 * the check constraints in `0069_products.sql` do. The SDK and the publish
 * route both read these, so neither can accept a listing the other refuses.
 */
export const LISTING_COUNT_LIMITS = {
  identifier: 120,
  pricePoints: 20,
  terms: 50,
} as const;

export const PRODUCT_TEXT_LIMITS = {
  summary: 280,
  description: 4000,
  notAFitWhenMin: 40,
  notAFitWhen: 1000,
} as const;

/**
 * The longest attribution window a program may declare, in days.
 *
 * The longest window a documented affiliate network allows is 365 days. The
 * platform checks the same number.
 */
export const ATTRIBUTION_WINDOW_MAX_DAYS = 365;
