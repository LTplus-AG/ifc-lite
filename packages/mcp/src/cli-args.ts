/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `ifc-lite-mcp` command line surface, declared once.
 *
 * There are two front doors to `createMCPServer`: the standalone
 * `ifc-lite-mcp` binary (`./cli.ts`) and the `ifc-lite mcp` subcommand in
 * `@ifc-lite/cli`. The binary's parser reads a flag and consumes its value in
 * the same branch, so it cannot disagree with itself; the subcommand has to
 * know which flags carry a value in order to skip them while collecting
 * positional `.ifc` paths, and kept its own hand-written copy of that list.
 *
 * The copy drifted. `--allow-origin` was added to the binary and never to the
 * subcommand's list, so `ifc-lite mcp --transport http --allow-origin
 * https://example.test model.ifc` skipped the flag, failed to skip its value,
 * and resolved the ORIGIN as a model file path. Declaring the flags here and
 * importing them on both sides means a new flag lands in one place.
 */

import { resolve } from 'node:path';

/** Flags that consume the following argv token as their value. */
export const MCP_VALUE_FLAGS: readonly string[] = [
  '--transport',
  '--port',
  '--host',
  '--token',
  '--bsdd',
  '--allow',
  '--allow-origin',
  '--viewer-port',
];

/** Flags that stand alone, taking no value. */
export const MCP_BOOLEAN_FLAGS: readonly string[] = [
  '--read-only',
  '--federate',
  '--insecure',
  '--viewer',
  '--open',
  '--help',
  '-h',
  '--version',
  '-v',
];

/**
 * Flags the standalone binary understands that the `ifc-lite mcp` subcommand
 * does not act on. Their VALUES are still skipped (that is what caused the
 * bogus-path bug), but the subcommand warns rather than pretending to honour
 * them.
 */
export const MCP_SUBCOMMAND_UNSUPPORTED_FLAGS: readonly string[] = [
  '--allow-origin',
  '--federate',
];

/** True when `arg` consumes the next argv token. */
export function isMcpValueFlag(arg: string): boolean {
  return MCP_VALUE_FLAGS.includes(arg);
}

export interface CliOptions {
  files: string[];
  readOnly: boolean;
  federate: boolean;
  transport: 'stdio' | 'http';
  port: number;
  /** undefined → caller didn't pass --host; CLI picks loopback by default */
  host?: string;
  token?: string;
  bsdd?: string;
  allowedPaths?: string[];
  /** Browser Origins allowed to read HTTP responses cross-origin. Empty = none. */
  allowedOrigins?: string[];
  autoViewer: boolean;
  viewerPort: number;
  openBrowser: boolean;
  insecure: boolean;
  /** `--help`/`-h` was passed. The caller prints usage and exits. */
  help: boolean;
  /** `--version`/`-v` was passed. The caller prints the version and exits. */
  version: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    files: [],
    readOnly: false,
    federate: false,
    transport: 'stdio',
    port: 8765,
    autoViewer: false,
    viewerPort: 0,
    openBrowser: false,
    insecure: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--read-only') opts.readOnly = true;
    else if (arg === '--federate') opts.federate = true;
    else if (arg === '--insecure') opts.insecure = true;
    else if (arg === '--transport') opts.transport = (argv[++i] as 'stdio' | 'http') ?? 'stdio';
    else if (arg === '--port') opts.port = Number(argv[++i] ?? 8765);
    else if (arg === '--host') opts.host = argv[++i];
    else if (arg === '--token') opts.token = argv[++i];
    else if (arg === '--bsdd') opts.bsdd = argv[++i];
    else if (arg === '--viewer') opts.autoViewer = true;
    else if (arg === '--viewer-port') opts.viewerPort = Number(argv[++i] ?? 0);
    else if (arg === '--open') { opts.autoViewer = true; opts.openBrowser = true; }
    else if (arg === '--allow') {
      const path = argv[++i];
      if (path) (opts.allowedPaths ??= []).push(resolve(path));
    } else if (arg === '--allow-origin') {
      const origin = argv[++i];
      if (origin) (opts.allowedOrigins ??= []).push(origin);
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--version' || arg === '-v') {
      opts.version = true;
    } else if (!arg.startsWith('-')) {
      opts.files.push(arg);
    }
  }
  return opts;
}

