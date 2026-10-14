# @metzia/sdk

The official TypeScript seller SDK for the [Metzia](https://metzia.ai) agentic-commerce marketplace.
Sellers use it to validate and publish product listings, register affiliate programs, and handle
and certify the order webhooks AI agents trigger.

## Install

```bash
npm install @metzia/sdk
```

Node 20 or later. The package ships ESM, CommonJS, and TypeScript declarations.

## Quick start

Describe the product, handle the two events, and serve the webhook:

```ts
import { Market } from "@metzia/sdk";

const market = new Market(process.env.METZIA_KEY, {
  webhookSecret: process.env.METZIA_WEBHOOK_SECRET,
});

await market.products.define(PRODUCT); // your listing, see "Validate a listing"
market.on("provision", async ({ buyerId, sku }) => accounts.upsert({ platformId: buyerId, sku }));
market.on("cancel", async ({ externalAccountId, sku }) => accounts.revoke(externalAccountId, sku));

// Next.js App Router: app/market/route.ts
export const POST = market.webhooks.handler();
```

`market.webhooks.handler()` returns a Web `Request` to `Response` handler, so it mounts directly on
any runtime that speaks the Fetch API. On Express, read the body raw before any JSON parser,
because the signature covers the exact bytes.

## Use

The constructor takes one platform key. The seller reads the key from the environment and passes
it in. The library reads no environment variable itself.

```ts
import { Market } from "@metzia/sdk";

const market = new Market(process.env.PLATFORM_KEY);
```

An empty key throws. A missing key is a configuration defect, and the message names
`PLATFORM_KEY`.

The default host is `https://api.metzia.ai`. Local work overrides it:

```ts
const market = new Market(key, { baseUrl: "http://localhost:3000" });
```

The base URL must be absolute, and it must carry no query and no fragment. A value the parser
rejects throws at construction, not on the first call.

## Results

A call returns a value. It does not throw on a non 2xx status, because a live API answers that way
every day:

```ts
const result = await market.request<{ products: Product[]; nextCursor: string | null }>(
  "/api/v1/products",
);

if (result.ok) {
  use(result.body);
} else if (result.code === "network") {
  // The request never reached the API.
} else if (result.code === "body") {
  // A 2xx whose body is not JSON. `result.status` and `result.body` hold the text.
} else {
  // A non 2xx answer. `result.status` and `result.body` hold the reason.
}
```

A 204, and any 2xx with an empty body, returns `ok` with `body` set to `undefined`. The type
argument is a claim about the shape, and the SDK checks nothing against it.

`market.request` never retries. `market.products.define` does, under the idempotency key that
makes a retry safe.

## Validate a listing

Validate a listing before sending it to the publish API. The schema uses the API wire field names,
including integer micro USD amounts. Validation is local and makes no network request.

The one rule this schema does not hold is the cancellation URL host. The server compares it with
your stored seller website domain, which only the server reads, so a listing that passes here can
still be refused at publish.

```ts
import { MarketValidationError, validateListing } from "@metzia/sdk";

try {
  const listing = validateListing({
    sku: "crm-pro",
    name: "CRM Pro",
    destinationPath: "/products/crm-pro",
    categorySlug: "crm",
    pricingModel: "seat",
    delivers: "seats",
    provisioning: "delegated",
    summary: "A CRM for growing service teams.",
    notAFitWhen:
      "A one-person team that prefers to keep every customer record in a spreadsheet.",
    pricePoints: [
      { amountMicros: 25_000_000, unitName: "per seat per month" },
    ],
  });
  // Send `listing` as the publish request body.
} catch (error) {
  if (error instanceof MarketValidationError) {
    for (const problem of error.errors) {
      // `field` is a stable wire path, for example pricePoints.0.amountMicros.
      showFieldError(problem.field, problem.message);
    }
  }
}
```

`destinationPath` is required. Write the product page path on the seller's own site, relative to
that site, for example `/products/crm-pro`. It starts with one slash, holds no backslash, and
holds no `.` or `..` segment. A template without `{DEST}` keeps its own landing URL, and the
platform places this path in the program's `{DEST}` macro when the template carries one. Do not
send an absolute URL.

`listingSchema` is also exported for callers that prefer Zod `safeParse`. Closed catalog constants,
`ListingInput`, `Listing`, and `MarketValidationError` are exported from the package root.

## Publish a listing

`market.products.define` validates the listing, checks its terms against the vocabulary, then
posts it to `POST /api/v1/products`. An invalid listing throws before any request, so it costs no
call.

The term check reads `GET /api/vocabulary` and refuses a `categorySlug` or an integration slug
outside it with `MarketValidationError`, before the publish. The message names the term and the
address of the list. One `Market` reads the list at most once per `vocabularyTtlMs`, one hour by
default, so two `define` calls make one vocabulary request. A term the platform added inside that
window can fail until the next read. When the SDK cannot read the list, `define` throws
`MarketNetworkError` and publishes nothing. `market.vocabulary.categories()` and
`market.vocabulary.integrations()` return the lists.

```ts
import {
  MarketConflictError,
  MarketRetryError,
  MarketValidationError,
} from "@metzia/sdk";

try {
  const { product, created, pendingReview } = await market.products.define(input);
  // `pendingReview` is true for a change to a live listing. Staff review it,
  // and `product` is the live version until they approve it.
  console.log(product.id, product.version, created, pendingReview);
  // On a 202, `submittedAt` and `message` say when the change arrived and what happens next.
} catch (error) {
  if (error instanceof MarketValidationError) {
    // One entry per field, from this SDK or from the platform.
  }
  if (error instanceof MarketRetryError) {
    // A rate limit or a busy platform. `retryAfterSeconds` names the wait.
  }
  if (error instanceof MarketConflictError) {
    // The same key already names another payload. See the paragraph below.
  }
}
```

Each call carries a new `Idempotency-Key`. One key names one `define` call, and every retry of
that call carries that one key. A call that arrives and loses its answer therefore replays the
stored answer, and it publishes no second listing.

A second `define` for one `sku` is an update. Before staff approve the listing, the route updates
the draft in place. After staff approve it, the platform answers 202 with `pendingReview` true,
`submittedAt`, and `message`. Staff review the change, and buyers keep the live version until they
approve it. A `define` of the live content again withdraws the change that waits.

Upgrade the SDK before you publish a change to a live listing. An SDK older than this version reads
the 202 as a publish that stands. It drops `pendingReview`, so the caller cannot tell that the change
waits for review.

A network failure is sent again three times, with waits of up to 200 ms, 400 ms, and 800 ms between
the attempts. Each wait is a random point in the upper half of its ceiling.
An attempt with no complete answer after 30 seconds counts as a network failure.
A 409 that names a wait says an earlier attempt of this call still runs. The SDK waits the named
seconds and asks again, at most twice, then raises `MarketRetryError`. It waits only after a
network failure of the same call, because such a 409 on the first attempt names another process.
Every other HTTP answer is sent once.

One `define` therefore sends at most 6 publish requests: 1 attempt, 3 network retries, and 2
waits. Each request counts against the hourly publish limit of the seller key, and so does each
wait. The vocabulary read, when the cache holds no current list, adds one request and its network
retries. It does not count against the publish limit.

Pass `signal` to stop a publish and its retries:

```ts
await market.products.define(input, { signal: AbortSignal.timeout(5_000) });
```

An abort raises the reason of the signal, which is the `AbortError` of the platform by default. An
aborted call sends no retry, and the platform may hold a listing of a call that already landed.

Pass `idempotencyKey` to name your own replay scope, such as one row of an import job:

```ts
await market.products.define(input, { idempotencyKey: "import-2026-04-11-row-42" });
```

The platform stores the answer of the first call under that key and replays it for ever. A later
payload under the same key throws `MarketConflictError`, so a caller that corrects a listing names
a new key.

## Register an affiliate program

`market.affiliate` states the commission terms the platform pays a referral on. The seller key
needs the scope `affiliate_program:write` to register or disable, and `affiliate_program:read` to
read. Those scopes are new, so a stored key holds neither, and a rotation copies the scopes a key
already carries. An existing key therefore never gains one. An owner mints a new key that names
them, on the seller portal page `/seller/keys` or with `POST /api/seller/keys` and a body that
states `label` and `scopes`.

WARNING: new terms stop commission until staff approve them again. Read the program first, and
register only when a term really changes. Terms equal to the stored program write nothing.

```ts
const current = await market.affiliate.get();

if (current?.rate !== 2500) {
  const program = await market.affiliate.register({
    programId: "impact-4821",
    rate: 2500,
    term: "twelve_months",
    linkTemplate: "https://impact.test/click?subId1={SUBID}",
  });
  console.log(program.programId, program.changed, program.approvalRequired);
}
```

`rate` is whole basis points. One percent is 100, so 2500 is 25 percent. A fractional rate throws
`MarketValidationError` with one entry that names `rate`.

`term` is one of `life_of_account`, `twelve_months`, and `first_invoice`. Any other word throws
`MarketValidationError` with one entry that names `term`.

`linkTemplate` is one absolute `https` URL that carries the placeholder `{SUBID}` at least once.
The platform replaces it with its own sub identifier. The lower case form `{subid}` also works. A
template with no placeholder throws `MarketValidationError` with one entry that names
`linkTemplate`.

The SDK trims the template before every other rule, so a trailing newline is not a change. It
refuses a template that holds a space or a control character after the trim, and one that holds a
placeholder after the fragment mark `#`. The platform refuses both at every click.

`programId` is the program's own id at the affiliate network. The result names the same value as
`networkProgramId`, and its `programId` is the platform's own id for the stored version. The two
are different identifiers, and `get` states both under the same two names.

`attributionWindowDays` is optional, from 1 to 365 days. A first registration that states none takes 30 days. A later
registration that states none keeps the window the stored program carries. Staff read the window
when they approve the program.

Every field the stored program carries and this call does not name keeps its stored value, so a
register never erases the network, the join URL, or the payout terms a seller declared on the
seller portal.

`get` returns the stored program, or `null` when the seller holds none:

```ts
const program = await market.affiliate.get();
// { programId, networkProgramId, rate, term, linkTemplate, confirmedAt, status }
```

`status` is one word. `not_started`, `applied`, `approved`, `rejected`, and `terminated` are the
enrolment lifecycle. `inactive` means the platform suspended or ended the program. Commission runs
on `approved` and on no other value. `approvalRequired` on a register result is true whenever the
program is not `approved`. `confirmedAt` is the instant staff approved the enrolment, and it is
null until they do.

`rate` reads null for a program that pays a fixed amount, and `term` reads `other` for a stored
month count this vocabulary cannot express. The seller portal states both.

`disable` ends the open program:

```ts
const { programId, changed } = await market.affiliate.disable();
```

A second `disable` answers `changed: false` and writes nothing. The SDK cannot enable a program
again. Register the terms to open a new version, which staff then approve.

A suspended program refuses both calls. `register` answers `program_inactive` and `disable`
answers `program_suspended`, and neither writes anything. Ask support to review the program.

No call carries an idempotency key, and none needs one. A register with the same terms writes
nothing, a read writes nothing, and a second disable changes nothing, so the SDK sends every call
again after a network failure, three times, with waits of up to 200 ms, 400 ms, and 800 ms between
the attempts. Each wait is a random point in the upper half of its ceiling. Each method takes an
optional `signal`, which stops the call and ends a wait between two attempts at once.

WARNING: a retry after a lost answer can report `changed: false` for a change the first attempt
made. The first attempt wrote the version, and the second one states the terms that now stand.
Call `market.affiliate.get()` to read the current terms.

## Certify your webhook receiver

`npx market certify --url <your receiver> --sku <sku>` sends your receiver two signed provision
calls for one order, a cancel, and a call with a bad signature. It passes when the retry links the
same account with `created: false`, the cancel answers 2xx, and the bad signature answers 401. It
prints one line per check and reports the run with `METZIA_KEY`, so the seller onboarding page shows
it. Pass `--no-report` to skip the report. `market certify --help` lists every option.
`npx market --version` prints the version you installed. `CHANGELOG.md` lists every release.

Your own process runs the checks, so the reported run is self-attested. Metzia does not treat it as
proof. The report goes to an https host only, except for `localhost`, because it carries your key.

## Node version

`engines` says `>=20`. CI tests Node 20, 22, and 24.

## Development

```bash
npm ci
npm run typecheck   # src and the config files under strict
npm run build       # writes ESM, CommonJS, and declarations into dist
npm test            # unit tests
npm run smoke       # loads the built package by name under import and require
```

Add a changeset to every pull request that changes `src` or `bin`. `.changeset/README.md` holds the
rules. A merge to `main` opens the release pull request, and merging that publishes to npm with a
provenance statement.

## License

[Apache License 2.0](LICENSE). `NOTICE` holds the attribution. The license grants no right to the
Metzia name or logo.
