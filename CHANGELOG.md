# @metzia/sdk

## 0.2.0

### Minor Changes

- 1e71678: `new Market(key, { baseUrl })` now refuses a base URL that does not use https, because every call sends the seller key in the `Authorization` header. Plain http is still allowed for `localhost`, `127.0.0.1`, and `[::1]`. This is a breaking change for a client that points at a plain http host on another machine: change the URL to https. `market certify --base-url` keeps the same rule, which now lives in one place.

### Patch Changes

- cd31bfc: `registerSchema` refuses a `programId` that holds a control or an invisible format character, as the API now does. Before, the API answered such a value with 503 and a retry hint, and a client retried a request that fails every time.
- 6e7b429: `validateListing` refuses a control character or an invisible character, such as a Unicode tag character, in `sku`, `name`, `pricePoints[].plan`, and `pricePoints[].unitName`, with the rule `hidden_character`. The API refuses the same values.
- 8192fca: `SLUG_PATTERN` escapes the hyphen in its character class. It accepts the same values, and a browser `pattern` attribute built from it now compiles under the `v` flag that HTML applies.

## 0.1.2

### Patch Changes

- 85db412: The package README now describes the public repository and how to contribute, and the package manifest drops the release scripts it no longer uses. No code changes.

## 0.1.1

### Patch Changes

- fd03831: The missing key error and the README now name `METZIA_KEY`, the same variable `market certify` reads, instead of `PLATFORM_KEY`. Rename the variable in your environment if you followed the old README. The SDK still reads no environment variable itself.

## 0.1.0

### Minor Changes

- 332ee0e: Publish the first release: the `Market` client, the listing schema and the vocabulary check, the webhook receiver and its signed events, the test signer at `@metzia/sdk/testing`, and the `market certify` command. `market --version` prints the installed version.
