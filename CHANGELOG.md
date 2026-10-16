# @metzia/sdk

## 0.1.2

### Patch Changes

- 85db412: The package README now describes the public repository and how to contribute, and the package manifest drops the release scripts it no longer uses. No code changes.

## 0.1.1

### Patch Changes

- fd03831: The missing key error and the README now name `METZIA_KEY`, the same variable `market certify` reads, instead of `PLATFORM_KEY`. Rename the variable in your environment if you followed the old README. The SDK still reads no environment variable itself.

## 0.1.0

### Minor Changes

- 332ee0e: Publish the first release: the `Market` client, the listing schema and the vocabulary check, the webhook receiver and its signed events, the test signer at `@metzia/sdk/testing`, and the `market certify` command. `market --version` prints the installed version.
