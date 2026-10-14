#!/usr/bin/env node
// The `market` command. `src/cli.ts` holds every rule and reads no Node API,
// so this file only hands it the process: the arguments, the environment,
// the output streams, the global fetch, and a random run id.
/* eslint-disable no-console, no-restricted-properties -- The command line entry hands the process
   environment and the output streams to src/cli.ts, which reads neither itself. A seller's
   METZIA_KEY and METZIA_WEBHOOK_SECRET live in the seller's shell, not in the platform env contract. */
import { randomUUID } from "node:crypto";

import { runCli } from "../dist/cli.js";

const code = await runCli(process.argv.slice(2), process.env, {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  fetch: (request) => fetch(request),
  runId: randomUUID(),
});

process.exit(code);
