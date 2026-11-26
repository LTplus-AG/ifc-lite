/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `ifc-lite-mcp` command line surface, declared once.
 *
 * There are two front doors to `createMCPServer`: the standalone
 * `ifc-lite-mcp` binary (`./cli.ts`) and the `ifc-lite mcp` subcommand in
 * `@ifc-lite/cli`. Both hand their argv to `runMcpCli` (`./cli-main.ts`),
 * which parses it here. The subcommand used to keep its own parser and its
 * own list of value-bearing flags; that copy drifted (`--allow-origin` was
 * resolved as a model path) and never learned the bridge flags, so there is
 * now one parser and no list to copy.
 */

import { resolve } from 'node:path';

/** Flags that consume the following argv token as their value. */
export const MCP_VALUE_FLAGS: readonly string[] = [
  '--transport',
  '--port',
  '--host',
  '--token',
  '--read-only-token',
  '--bsdd',
  '--allow',
  '--allow-origin',
  '--viewer-port',
  '--bridge-port',
  '--bridge-viewer-url',
];

/**
 * Flags that stand alone, taking no value. `--federate` is accepted only so
 * older configs keep starting: it never did anything (every positional file
 * already loads into one session), and the parser warns about it.
 */
export const MCP_BOOLEAN_FLAGS: readonly string[] = [
  '--read-only',
  '--federate',
  '--insecure',
  '--viewer',
  '--open',
  '--bridge',
  '--channel',
  '--help',
  '-h',
  '--version',
  '-v',
];

/** True when `arg` consumes the next argv token. */
export function isMcpValueFlag(arg: string): boolean {
  return MCP_VALUE_FLAGS.includes(arg);
}

export interface CliOptions {
  files: string[];
  readOnly: boolean;
  transport: 'stdio' | 'http';
  port: number;
  /** undefined → caller didn't pass --host; CLI picks loopback by default */
  host?: string;
  /** `--token`, repeatable. Each one gets the server's scope (read scope under --read-only). */
  tokens: string[];
  /** `--read-only-token`, repeatable. Each one gets read scope. */
  readOnlyTokens: string[];
  bsdd?: string;
  allowedPaths?: string[];
  /** Browser Origins allowed to read HTTP responses cross-origin. Empty = none. */
  allowedOrigins?: string[];
  autoViewer: boolean;
  viewerPort: number;
  openBrowser: boolean;
  insecure: boolean;
  /**
   * `--bridge`: forward tools to a paired browser tab instead of loading files.
   * Optional so code that builds a `CliOptions` itself keeps compiling;
   * `parseArgs` always sets it.
   */
  bridge?: boolean;
  /** `--channel` (bridge only): push viewer UI events as Claude Code channel messages. */
  channel?: boolean;
  /** `--bridge-port`; undefined means `DEFAULT_BRIDGE_PORT`. 0 picks a free port. */
  bridgePort?: number;
  /** `--bridge-viewer-url`: base of the pairing link; its origin may connect. */
  bridgeViewerUrl?: string;
  /** Bridge value flags given without an operand; `bridgeConflict` reports them. */
  bridgeMissingOperand?: string[];
  /** `--help`/`-h` was passed. The caller prints usage and exits. */
  help: boolean;
  /** `--version`/`-v` was passed. The caller prints the version and exits. */
  version: boolean;
  /**
   * Usage problems that should not stop the server: unknown flags and flags
   * that do nothing. The caller prints them on stderr. They are warnings, not
   * errors, because MCP client configs written for older versions still pass
   * flags this version dropped.
   */
  warnings: string[];
  /**
   * Usage errors: a value flag with no value. The caller prints them and
   * exits without starting, since guessing could drop a token or --read-only.
   */
  errors: string[];
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    files: [],
    readOnly: false,
    tokens: [],
    readOnlyTokens: [],
    transport: 'stdio',
    port: 8765,
    autoViewer: false,
    viewerPort: 0,
    openBrowser: false,
    insecure: false,
    bridge: false,
    channel: false,
    help: false,
    version: false,
    warnings: [],
    errors: [],
  };
  const known = new Set([...MCP_VALUE_FLAGS, ...MCP_BOOLEAN_FLAGS]);
  let i = 0;
  /**
   * The value after the flag at `i`, consumed. A known flag is never a value:
   * `--token --read-only` must not register '--read-only' as a credential and
   * drop read-only mode. Anything else is, so a token may start with '-'.
   */
  const value = (flag: string): string | undefined => {
    const next = argv[i + 1];
    if (next === undefined || next === '' || known.has(next)) {
      opts.errors.push(`${flag} needs a value.`);
      return undefined;
    }
    i++;
    return next;
  };
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--read-only') opts.readOnly = true;
    // TODO(remove-by: @ifc-lite/mcp 1.0, louistrue): drop --federate (#11534).
    else if (arg === '--federate') {
      opts.warnings.push('--federate does nothing: every file passed is loaded into the same session. Drop it.');
    }
    else if (arg === '--insecure') opts.insecure = true;
    else if (arg === '--transport') opts.transport = (value(arg) as 'stdio' | 'http' | undefined) ?? 'stdio';
    else if (arg === '--port') opts.port = Number(value(arg) ?? 8765);
    else if (arg === '--host') opts.host = value(arg);
    else if (arg === '--token' || arg === '--read-only-token') {
      const token = value(arg);
      if (token !== undefined) (arg === '--token' ? opts.tokens : opts.readOnlyTokens).push(token);
    }
    else if (arg === '--bsdd') opts.bsdd = value(arg);
    else if (arg === '--viewer') opts.autoViewer = true;
    else if (arg === '--viewer-port') opts.viewerPort = Number(value(arg) ?? 0);
    else if (arg === '--open') { opts.autoViewer = true; opts.openBrowser = true; }
    else if (arg === '--bridge') opts.bridge = true;
    else if (arg === '--channel') opts.channel = true;
    else if (arg === '--bridge-port' || arg === '--bridge-viewer-url') {
      // A missing operand (end of argv, or the next flag) is a usage error,
      // not a silent fall-back to the default port or viewer URL.
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('-')) {
        (opts.bridgeMissingOperand ??= []).push(arg);
        continue;
      }
      i++;
      if (arg === '--bridge-port') opts.bridgePort = Number(value);
      else opts.bridgeViewerUrl = value;
    }
    else if (arg === '--allow') {
      const path = value(arg);
      if (path !== undefined) (opts.allowedPaths ??= []).push(resolve(path));
    } else if (arg === '--allow-origin') {
      const origin = value(arg);
      if (origin !== undefined) (opts.allowedOrigins ??= []).push(origin);
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--version' || arg === '-v') {
      opts.version = true;
    } else if (!arg.startsWith('-')) {
      opts.files.push(arg);
    } else {
      opts.warnings.push(`unknown flag ${arg} ignored. Run with --help for the flags this version knows.`);
    }
  }
  return opts;
}

/**
 * Why `--bridge` cannot run with these options, or null. The bridge has no
 * model of its own and speaks stdio only.
 */
export function bridgeConflict(opts: CliOptions): string | null {
  if (!opts.bridge) return opts.channel ? '--channel needs --bridge: it pushes events from the paired viewer tab.' : null;
  if (opts.bridgeMissingOperand?.length) return `${opts.bridgeMissingOperand.join(', ')} needs a value.`;
  if (opts.files.length > 0) return `--bridge serves the model open in a browser tab and loads no files; drop ${opts.files.join(', ')}.`;
  if (opts.transport !== 'stdio') return '--bridge speaks MCP over stdio only; drop --transport http.';
  if (opts.autoViewer) return '--bridge cannot be combined with --viewer or --open: the browser tab is the viewer.';
  if (opts.bridgePort !== undefined && (!Number.isInteger(opts.bridgePort) || opts.bridgePort < 0 || opts.bridgePort > 65535)) {
    return '--bridge-port must be an integer from 0 to 65535 (0 picks a free port).';
  }
  return null;
}

