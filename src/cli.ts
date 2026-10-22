import { runCertification, type CertificationResult } from "./certify";
import { joinUrl, request } from "./http";
import { checkBaseUrl, DEFAULT_BASE_URL } from "./market";
import { SDK_VERSION } from "./version";

/**
 * The `market` command.
 *
 * `bin/market.mjs` passes the process arguments, the environment, and the
 * output to `runCli`, so this module reads no Node API and a test drives it
 * whole. It has one command, `certify`, and `market --version` prints the
 * version of the installed package.
 *
 * `certify` runs `runCertification` against the seller's receiver, prints one
 * line per check, and reports the run to the platform with the seller's key,
 * which names the seller. It answers exit code 0 when every check passed and
 * the report landed, 1 on any failure, and 2 on a usage error.
 *
 * The report goes through `request()` in `src/http.ts`, so it has the same
 * timeout as every SDK call. The report carries the key, so the command
 * refuses a `--base-url` on plain http unless the host is this machine.
 */

/** The platform path a run is reported to. */
export const CERTIFICATION_PATH = "/api/v1/certification";

export const CLI_HELP = `Usage: market certify --url <handler-url> --sku <sku> [options]
       market --version

Sends your webhook receiver two signed provision calls for one order, a cancel,
and a call with a bad signature, and checks each answer.

Options:
  --url <handler-url>   Your webhook receiver. Required.
  --sku <sku>           A sku your provision handler knows. Required.
  --secret <secret>     The webhook signing secret. Default: METZIA_WEBHOOK_SECRET.
  --key <key>           Your platform key, to report the run. Set METZIA_KEY instead:
                        a flag value stays in the shell history and the process list.
  --base-url <url>      The platform host the run is reported to. Default: METZIA_BASE_URL, then ${DEFAULT_BASE_URL}.
                        It must use https, except for localhost.
  --no-report           Run the checks and report nothing.
  --help                Print this text.
  --version             Print the version of the SDK and stop.

Exit code 0 when every check passed, 1 on a failed check or a failed report, 2 on a usage error.`;

export type CliIo = {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Sends the receiver calls. The report goes through `request()` and the global fetch. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** Names the test buyer and order. The bin passes a random UUID. */
  readonly runId: string;
};

type Flags = Record<string, string | true>;

/** The flags that never take a value, so `--no-report extra` refuses `extra`. */
const SWITCHES = new Set(["no-report", "help"]);

/** Reads `--name value` and `--flag` pairs. A value never starts with `--`. */
function parseFlags(args: readonly string[]): Flags | string {
  const flags: Flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined || !arg.startsWith("--")) return `Unexpected argument "${arg ?? ""}".`;
    const name = arg.slice(2);
    const next = args[i + 1];
    if (SWITCHES.has(name) || next === undefined || next.startsWith("--")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return flags;
}

const KNOWN_FLAGS = new Set(["url", "sku", "secret", "key", "base-url", "no-report", "help"]);

function text(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The receiver URL with no userinfo, query, or fragment, or a usage error. */
function receiverUrl(value: string): URL | string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `The --url "${value}" is not an absolute URL.`;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return `The --url "${value}" must use http or https.`;
  }
  // A signed Request refuses a URL with credentials, and the report must not carry them.
  if (parsed.username !== "" || parsed.password !== "") {
    return "The --url must not hold a user name or a password. Remove them and run again.";
  }
  return parsed;
}

/** The usage error of a report host, or null. `checkBaseUrl` holds the https rule. */
function baseUrlProblem(value: string): string | null {
  try {
    checkBaseUrl(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function report(
  result: CertificationResult,
  handlerUrl: string,
  key: string,
  baseUrl: string,
  io: CliIo,
): Promise<boolean> {
  const url = joinUrl(baseUrl, CERTIFICATION_PATH);
  const answer = await request<unknown>(key, baseUrl, CERTIFICATION_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handlerUrl, sdkVersion: SDK_VERSION, passed: result.passed, checks: result.checks }),
  });

  if (answer.ok) {
    io.out(`Reported the run to ${url}.`);
    return true;
  }
  if (answer.code === "network") {
    const reason = answer.error instanceof Error ? answer.error.message : String(answer.error);
    io.err(`The run was not reported to ${url}: ${reason}. Run the command again.`);
    return false;
  }
  io.err(`The run was not reported: ${url} answered HTTP ${answer.status}.`);
  return false;
}

export async function runCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "help") {
    io.out(CLI_HELP);
    return command === undefined ? 2 : 0;
  }
  if (command === "--version" || command === "version") {
    io.out(SDK_VERSION);
    return 0;
  }
  if (command !== "certify") {
    io.err(`Unknown command "${command}".`);
    io.err(CLI_HELP);
    return 2;
  }

  const flags = parseFlags(rest);
  if (typeof flags === "string") {
    io.err(flags);
    return 2;
  }
  if (flags.help === true) {
    io.out(CLI_HELP);
    return 0;
  }
  const unknown = Object.keys(flags).find((name) => !KNOWN_FLAGS.has(name));
  if (unknown !== undefined) {
    io.err(`Unknown option --${unknown}. Run market certify --help.`);
    return 2;
  }

  const url = text(flags, "url");
  const sku = text(flags, "sku");
  const secret = text(flags, "secret") ?? env.METZIA_WEBHOOK_SECRET?.trim();
  if (url === undefined || sku === undefined || secret === undefined || secret === "") {
    io.err("market certify needs --url, --sku, and a webhook secret in --secret or METZIA_WEBHOOK_SECRET.");
    return 2;
  }
  const receiver = receiverUrl(url);
  if (typeof receiver === "string") {
    io.err(receiver);
    return 2;
  }
  const reporting = flags["no-report"] !== true;
  const baseUrl = text(flags, "base-url") ?? (env.METZIA_BASE_URL?.trim() || DEFAULT_BASE_URL);
  const problem = reporting ? baseUrlProblem(baseUrl) : null;
  if (problem !== null) {
    io.err(problem);
    return 2;
  }

  const result = await runCertification({ url, secret, sku, runId: io.runId, fetch: io.fetch });
  for (const check of result.checks) {
    io.out(`${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  io.out(result.passed ? "Every check passed." : "At least one check failed.");

  if (!reporting) return result.passed ? 0 : 1;

  const key = text(flags, "key") ?? env.METZIA_KEY?.trim();
  if (key === undefined || key === "") {
    io.err("The run was not reported, because no platform key was given in METZIA_KEY or --key. Pass --no-report to skip it.");
    return 1;
  }
  const reported = await report(result, `${receiver.origin}${receiver.pathname}`, key, baseUrl, io);

  return result.passed && reported ? 0 : 1;
}
