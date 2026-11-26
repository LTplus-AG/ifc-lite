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


export interface CliOptions {
  files: string[];
  readOnly: boolean;
  transport: 'stdio' | 'http';
  port: number;
  /** undefined → caller didn't pass --host; CLI picks loopback by default */
  host?: string;
  /** `--token`, repeatable. Each one gets the server's scope (the --read-only preset under --read-only). */
  tokens: string[];
  /** `--read-only-token`, repeatable. Each gets the --read-only preset (read, validate, export). */
  readOnlyTokens: string[];
  bsdd?: string;
  allowedPaths?: string[];
  /** Browser Origins allowed to read HTTP responses cross-origin. Empty = none. */
  allowedOrigins?: string[];
  autoViewer: boolean;
  viewerPort: number;
  openBrowser: boolean;
  insecure: boolean;
  /** `--bridge`: forward tools to a paired browser tab instead of loading files. */
  bridge: boolean;
  /** `--channel` (bridge only): push viewer UI events as Claude Code channel messages. */
  channel?: boolean;
  /** `--bridge-port`; undefined means `DEFAULT_BRIDGE_PORT`. 0 picks a free port. */
  bridgePort?: number;
  /** `--bridge-viewer-url`: base of the pairing link; its origin may connect. */
  bridgeViewerUrl?: string;
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

const KNOWN_FLAGS: ReadonlySet<string> = new Set([...MCP_VALUE_FLAGS, ...MCP_BOOLEAN_FLAGS]);

/**
 * `--flag=value` for a value flag becomes `--flag value`, and `explicit`
 * records the value's index so a value starting with `--` is accepted. Any
 * other `=` form is left whole and reported as unknown by its name alone,
 * since the part after `=` may be a credential.
 */
function splitEquals(raw: string[]): { argv: string[]; explicit: Set<number> } {
  const argv: string[] = [];
  const explicit = new Set<number>();
  for (const arg of raw) {
    const eq = arg.indexOf('=');
    const name = arg.slice(0, eq);
    if (arg.startsWith('--') && eq >= 0 && MCP_VALUE_FLAGS.includes(name)) {
      argv.push(name);
      explicit.add(argv.length);
      argv.push(arg.slice(eq + 1));
    } else {
      argv.push(arg);
    }
  }
  return { argv, explicit };
}

export function parseArgs(rawArgv: string[]): CliOptions {
  const { argv, explicit } = splitEquals(rawArgv);
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
  let i = 0;
  /**
   * The value after the flag at `i`, consumed. Nothing that starts with `--`
   * is a value: `--token --read-only` must not register '--read-only' as a
   * credential and drop read-only mode, and neither may a misspelled
   * `--read-onli`. A value that really starts with `--` uses `--token=--…`;
   * one starting with a single '-' is still taken. An unknown `--…` here is
   * swallowed, never echoed: it may be the secret the user meant to pass.
   */
  const value = (flag: string): string | undefined => {
    const next = argv[i + 1];
    if (next === undefined || next === '' || (!explicit.has(i + 1) && KNOWN_FLAGS.has(next))) {
      opts.errors.push(`${flag} needs a value.`);
      return undefined;
    }
    if (!explicit.has(i + 1) && next.startsWith('--')) {
      i++;
      opts.errors.push(`${flag} needs a value; the next argument starts with '--'. Pass ${flag}=<value> if the value starts with '--'.`);
      return undefined;
    }
    i++;
    return next;
  };
  /** A port value, 0 to 65535; anything else is a usage error. */
  const port = (flag: string): number | undefined => {
    const v = value(flag);
    if (v === undefined) return undefined;
    if (/^\d+$/.test(v) && Number(v) <= 65535) return Number(v);
    opts.errors.push(`${flag} must be an integer from 0 to 65535.`);
    return undefined;
  };
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--read-only') opts.readOnly = true;
    // TODO(remove-by: @ifc-lite/mcp 1.0, louistrue): drop --federate (#11534).
    else if (arg === '--federate') {
      opts.warnings.push('--federate does nothing: every file passed is loaded into the same session. Drop it.');
    }
    else if (arg === '--insecure') opts.insecure = true;
    else if (arg === '--transport') {
      const v = value(arg);
      if (v === 'stdio' || v === 'http') opts.transport = v;
      else if (v !== undefined) opts.errors.push('--transport must be stdio or http.');
    }
    else if (arg === '--port') opts.port = port(arg) ?? opts.port;
    else if (arg === '--host') opts.host = value(arg);
    else if (arg === '--token' || arg === '--read-only-token') {
      const token = value(arg);
      if (token !== undefined) (arg === '--token' ? opts.tokens : opts.readOnlyTokens).push(token);
    }
    else if (arg === '--bsdd') opts.bsdd = value(arg);
    else if (arg === '--viewer') opts.autoViewer = true;
    else if (arg === '--viewer-port') opts.viewerPort = port(arg) ?? opts.viewerPort;
    else if (arg === '--open') { opts.autoViewer = true; opts.openBrowser = true; }
    else if (arg === '--bridge') opts.bridge = true;
    else if (arg === '--channel') opts.channel = true;
    else if (arg === '--bridge-port') opts.bridgePort = port(arg);
    else if (arg === '--bridge-viewer-url') opts.bridgeViewerUrl = value(arg);
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
      const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
      // `--read-only=true` must not start a writable server with a warning.
      if (flag !== arg && MCP_BOOLEAN_FLAGS.includes(flag)) opts.errors.push(`${flag} takes no value.`);
      else opts.warnings.push(`unknown flag ${flag === arg ? arg : `${flag}=…`} ignored. Run with --help for the flags this version knows.`);
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
  // The count, not the values: a mistyped value flag leaves its value
  // (maybe a token) as a positional, and stderr ends up in client logs.
  if (opts.files.length > 0) return `--bridge serves the model open in a browser tab and loads no files; drop the ${opts.files.length} file argument(s).`;
  if (opts.transport !== 'stdio') return '--bridge speaks MCP over stdio only; drop --transport http.';
  if (opts.autoViewer) return '--bridge cannot be combined with --viewer or --open: the browser tab is the viewer.';
  return null;
}

