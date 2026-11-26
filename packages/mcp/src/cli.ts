#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite-mcp` — start an MCP server over stdio (default) or Streamable HTTP.
 *
 * Usage:
 *   ifc-lite-mcp ./model.ifc
 *   ifc-lite-mcp ./model.ifc --read-only
 *   ifc-lite-mcp --transport http --port 8765 --token abc123
 *   ifc-lite-mcp --bridge
 *
 * The runtime lives in `./cli-main.ts`, shared with `ifc-lite mcp`.
 */

import { runMcpCli } from './cli-main.js';

runMcpCli(process.argv.slice(2), { command: 'ifc-lite-mcp' }).catch((err: Error) => {
  process.stderr.write(`[ifc-lite-mcp] fatal: ${err.message}\n`);
  if (process.env.DEBUG) process.stderr.write(`${err.stack ?? ''}\n`);
  process.exit(1);
});
