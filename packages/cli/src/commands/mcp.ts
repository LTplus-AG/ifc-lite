/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite mcp` — start an MCP server bound to the supplied IFC files.
 *
 * The same runtime as the standalone `ifc-lite-mcp` binary: argv goes to
 * `runMcpCli`, which owns the flag parser, both transports and the bridge.
 * This subcommand used to parse its own flags, and its copy lacked the bridge
 * flags and once resolved an `--allow-origin` value as a model path.
 */

import { mcpHelpText, runMcpCli } from '@ifc-lite/mcp/cli-main';

const IDENTITY = { command: 'ifc-lite mcp' };

export async function mcpCommand(args: string[]): Promise<void> {
  // Typed at a terminal with nothing else: show usage rather than wait for
  // JSON-RPC on stdin that a person will never send.
  if (args.length === 0 && (process.stdin.isTTY ?? false)) {
    process.stdout.write(mcpHelpText(IDENTITY));
    return;
  }
  await runMcpCli(args, IDENTITY);
}
