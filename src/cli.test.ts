import { afterEach, describe, expect, it, vi } from "vitest";

import { CERTIFICATION_PATH, CLI_HELP, runCli } from "./cli";
import { Market } from "./market";
import { SDK_VERSION } from "./version";

const SECRET = "whsec_cli_test";
const HANDLER = "https://seller.example.test/metzia-webhooks";
const BASE = "https://api.example.test";

/** An idempotent receiver built with the SDK. */
function receiver(idempotent = true) {
  const accounts = new Map<string, string>();
  const market = new Market("osk_sel_TESTKEY", { baseUrl: BASE, webhookSecret: SECRET });
  market.on("provision", async ({ orderId }) => {
    const existing = accounts.get(orderId);
    if (idempotent && existing !== undefined) return { externalAccountId: existing, created: false };
    const id = `acct_${accounts.size + 1}`;
    accounts.set(`${orderId}-${accounts.size}`, id);
    accounts.set(orderId, id);
    return { externalAccountId: id, created: true };
  });
  market.on("cancel", async () => undefined);
  return market.webhooks.handler();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Routes the receiver calls to the receiver. The report goes through
 * `request()`, which calls the global fetch, so a stub records it.
 */
function io(options: { idempotent?: boolean; reportStatus?: number; reportError?: Error } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const reports: { url: string; auth: string | null; body: unknown }[] = [];
  const handler = receiver(options.idempotent ?? true);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (options.reportError !== undefined) throw options.reportError;
    const headers = new Headers(init.headers);
    reports.push({ url, auth: headers.get("authorization"), body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: options.reportStatus ?? 201 });
  });
  return {
    out,
    err,
    reports,
    value: {
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
      runId: "run-1",
      fetch: async (request: Request) => handler(request),
    },
  };
}

const ARGS = ["certify", "--url", HANDLER, "--sku", "crm-pro", "--secret", SECRET];

describe("market --version", () => {
  it.each([["--version"], ["version"]])("prints only the package version for %s and exits 0", async (flag) => {
    const run = io();

    await expect(runCli([flag], {}, run.value)).resolves.toBe(0);
    expect(run.out).toEqual([SDK_VERSION]);
    expect(run.err).toEqual([]);
    expect(run.reports).toEqual([]);
  });

  it("names the flag in the help text", () => {
    expect(CLI_HELP).toContain("market --version");
  });
});

describe("market certify", () => {
  it("prints the flags for --help and exits 0", async () => {
    const run = io();

    await expect(runCli(["certify", "--help"], {}, run.value)).resolves.toBe(0);
    expect(run.out.join("\n")).toBe(CLI_HELP);
    for (const flag of ["--url", "--sku", "--secret", "--key", "--base-url", "--no-report"]) {
      expect(CLI_HELP).toContain(flag);
    }
  });

  it("passes, prints one line per check, reports the run once with the key, and exits 0", async () => {
    const run = io();

    await expect(runCli([...ARGS, "--key", "osk_sel_KEY", "--base-url", BASE], {}, run.value)).resolves.toBe(0);

    expect(run.out.filter((line) => line.startsWith("PASS "))).toHaveLength(4);
    expect(run.reports).toHaveLength(1);
    expect(run.reports[0]).toMatchObject({
      url: `${BASE}${CERTIFICATION_PATH}`,
      auth: "Bearer osk_sel_KEY",
      body: { handlerUrl: HANDLER, sdkVersion: SDK_VERSION, passed: true },
    });
    expect((run.reports[0]?.body as { checks: unknown[] }).checks).toHaveLength(4);
  });

  it("names the idempotency check and exits 1 for a handler that creates an account on every call", async () => {
    const run = io({ idempotent: false });

    await expect(runCli([...ARGS, "--no-report"], {}, run.value)).resolves.toBe(1);

    expect(run.out.find((line) => line.startsWith("FAIL "))).toMatch(/^FAIL provision_is_idempotent:/);
    expect(run.reports).toHaveLength(0);
  });

  it("reads the secret, the key, and the host from the environment", async () => {
    const run = io();

    await expect(
      runCli(["certify", "--url", HANDLER, "--sku", "crm-pro"], {
        METZIA_WEBHOOK_SECRET: SECRET,
        METZIA_KEY: "osk_sel_ENV",
        METZIA_BASE_URL: BASE,
      }, run.value),
    ).resolves.toBe(0);
    expect(run.reports[0]?.auth).toBe("Bearer osk_sel_ENV");
  });

  it("exits 1 when the run cannot be reported, and says so", async () => {
    const run = io({ reportStatus: 401 });

    await expect(runCli([...ARGS, "--key", "osk_sel_BAD", "--base-url", BASE], {}, run.value)).resolves.toBe(1);
    expect(run.err.join("\n")).toContain("answered HTTP 401");
  });

  it("exits 1 with no key, and names the way to skip the report", async () => {
    const run = io();

    await expect(runCli(ARGS, {}, run.value)).resolves.toBe(1);
    expect(run.err.join("\n")).toContain("--no-report");
  });

  it.each([
    ["no command", []],
    ["an unknown command", ["deploy"]],
    ["a missing --sku", ["certify", "--url", HANDLER, "--secret", SECRET]],
    ["no secret", ["certify", "--url", HANDLER, "--sku", "crm-pro"]],
    ["an unknown option", [...ARGS, "--seller", "slr_1"]],
    ["a relative --url", ["certify", "--url", "/hooks", "--sku", "crm-pro", "--secret", SECRET]],
    ["a --url with credentials", ["certify", "--url", "https://admin:pw@seller.example.test/hook", "--sku", "crm-pro", "--secret", SECRET]],
    ["a --url that is not http", ["certify", "--url", "ftp://seller.example.test/hook", "--sku", "crm-pro", "--secret", SECRET]],
    ["a value after --no-report", [...ARGS, "--no-report", "extra"]],
    ["a plain http --base-url", [...ARGS, "--key", "osk_sel_KEY", "--base-url", "http://api.example.test"]],
    ["a --base-url with a query", [...ARGS, "--key", "osk_sel_KEY", "--base-url", `${BASE}?x=1`]],
  ])("exits 2 on %s, before any call", async (_label, argv) => {
    const run = io();
    const receiverCalls = vi.fn(run.value.fetch);

    await expect(runCli(argv, {}, { ...run.value, fetch: receiverCalls })).resolves.toBe(2);
    expect(receiverCalls).not.toHaveBeenCalled();
    expect(run.reports).toHaveLength(0);
  });

  it("reports to a plain http host on localhost", async () => {
    const run = io();

    await expect(
      runCli([...ARGS, "--key", "osk_sel_KEY", "--base-url", "http://localhost:3000"], {}, run.value),
    ).resolves.toBe(0);
    expect(run.reports[0]?.url).toBe(`http://localhost:3000${CERTIFICATION_PATH}`);
  });

  it("reports the handler URL with no query or fragment", async () => {
    const run = io();

    await expect(
      runCli(
        ["certify", "--url", `${HANDLER}?token=abc#frag`, "--sku", "crm-pro", "--secret", SECRET, "--key", "osk_sel_KEY", "--base-url", BASE],
        {},
        run.value,
      ),
    ).resolves.toBe(0);
    expect(run.reports[0]?.body).toMatchObject({ handlerUrl: HANDLER });
  });

  it("exits 1 and names the cause when the report cannot reach the host", async () => {
    const run = io({ reportError: new Error("connect ECONNREFUSED") });

    await expect(runCli([...ARGS, "--key", "osk_sel_KEY", "--base-url", BASE], {}, run.value)).resolves.toBe(1);
    expect(run.err.join("\n")).toContain("ECONNREFUSED");
  });

  it("tells the seller to prefer METZIA_KEY over --key", () => {
    expect(CLI_HELP).toMatch(/--key <key>.*Set METZIA_KEY instead/);
  });
});
