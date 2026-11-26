/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The MCP server's command line runtime, shared by both front doors: the
 * standalone `ifc-lite-mcp` binary (`./cli.ts`) and the `ifc-lite mcp`
 * subcommand in `@ifc-lite/cli`. Each passes its argv and the name it prints
 * in usage and log lines; everything else (flags, transports, the bridge) is
 * the same code, so the two cannot drift apart again.
 */

import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { bridgeConflict, parseArgs, type CliOptions } from './cli-args.js';
import { startBridgeServer, type RunningBridge } from './bridge/run.js';
import { DEFAULT_BRIDGE_PORT, DEFAULT_BRIDGE_VIEWER_URL } from './bridge/protocol.js';
import { StdioTransport } from './transport/stdio.js';
import { routeConsoleToStderr } from './transport/stdio-console.js';
import { HttpTransport, BearerTokenAuth, AllowAllAuth, type HttpAuthenticator, type SessionFactory } from './transport/http.js';
import { createMCPServer, VERSION } from './index.js';
import { deriveModelId, loadIfcModel } from './loader.js';
import { anonymousHttpScope, claudeDesktopConfigPath, serverScope, tokenScopes } from './cli-support.js';
import { InMemoryModelRegistry, type ModelRegistry } from './context.js';
import { fmtInt } from './tools/util.js';

export interface McpCliIdentity {
  /** How the user invoked us, for usage text: `ifc-lite-mcp` or `ifc-lite mcp`. */
  command: string;
}

export function mcpHelpText({ command }: McpCliIdentity, platform: NodeJS.Platform = process.platform): string {
  return `
  ${command} v${VERSION} — Model Context Protocol server for ifc-lite

  Usage: ${command} [files…] [options]

  Over stdio the files are loaded at startup. Over HTTP each session starts
  empty and the agent loads models with model_load.

  Options:
    --read-only             Hide all mutation tools regardless of scope.
                            Models can still be loaded and unloaded.
                            With --bridge: hide and refuse the tools the tab
                            LABELS as mutating; the tab enforces the rest.
    --transport <stdio|http>  Default: stdio.
    --port <n>              HTTP port (default 8765).
    --host <h>              HTTP host. Default 127.0.0.1 (loopback). A
                            non-loopback host needs --token, --read-only-token
                            or --insecure.
    --token <t>             Bearer token for HTTP auth (repeatable). Each gets
                            full scope, or read scope under --read-only.
    --read-only-token <t>   Bearer token with read scope only (repeatable).
    --insecure              Allow non-loopback bind without authentication.
                            Required when combining a public --host with no
                            token. NEVER use in production.
                            With --bridge: accept a plain-http origin on a
                            non-loopback host (refused otherwise).
    --bsdd <url>            Override bSDD endpoint.
    --allow <path>          Restrict file-system access to this directory or
                            file (repeatable). Applies to stdio and HTTP.
    --allow-origin <origin> Permit a browser Origin to read HTTP responses
                            cross-origin (repeatable). Default: none — visited
                            web pages cannot read responses or invoke tools.
                            With --bridge: an extra Origin that may connect.
    --viewer                Auto-open the in-process WebGL viewer at startup.
    --viewer-port <n>       Preferred viewer port (0 = auto).
    --open                  Implies --viewer; also tries to open the URL in
                            the default browser via the OS opener.
    --bridge                Serve the model open in an ifc-lite browser tab:
                            stdio MCP here, forwarded to one paired tab over
                            ws://127.0.0.1. Loads no files. Pair through the
                            link printed below or the bridge_status tool.
    --bridge-port <n>       Bridge port (default ${DEFAULT_BRIDGE_PORT}; 0 = pick a free one).
    --bridge-viewer-url <u> Base of the pairing link (default
                            ${DEFAULT_BRIDGE_VIEWER_URL}). Its origin replaces the
                            default in the allowed origins; add
                            --allow-origin ${DEFAULT_BRIDGE_VIEWER_URL} to keep it.
    --channel               With --bridge: also push clicks on agent surfaces
                            into a Claude Code session as channel messages
                            (research preview; start Claude Code with a
                            channel flag naming this server).
    --version, -v           Print version.
    --help, -h              This message.

  Examples:
    ${command} ./model.ifc
    ${command} ./arch.ifc ./struct.ifc
    ${command} ./model.ifc --read-only
    ${command} --transport http --port 8765 --token abc
    ${command} --bridge

  Claude Desktop config (${claudeDesktopConfigPath(platform)}):
    {
      "mcpServers": {
        "ifc-lite": {
          "command": "npx",
          "args": ["-y", "@ifc-lite/mcp", "/abs/path/to/model.ifc"]
        }
      }
    }
`;
}

/** A running HTTP server, so a caller (a test) can find and stop it. */
export interface RunningHttpCli {
  port: number;
  close(): Promise<void>;
}

/**
 * Parse `argv` and run the server it describes. Resolves once the server is
 * listening (it then keeps the process alive), with a handle for the HTTP
 * transport; usage errors set `process.exitCode` and resolve without
 * starting anything. Load failures reject, for the caller's fatal handler.
 */
export async function runMcpCli(argv: string[], identity: McpCliIdentity): Promise<RunningHttpCli | undefined> {
  const opts = parseArgs(argv);
  const tag = `[${identity.command}]`;
  // `process.exitCode` + return, NOT `process.exit(0)`: writes to a pipe are
  // asynchronous, and `process.exit` does not wait for them.
  if (opts.help) {
    process.stdout.write(mcpHelpText(identity));
    process.exitCode = 0;
    return undefined;
  }
  if (opts.version) {
    process.stdout.write(`${identity.command} ${VERSION}\n`);
    process.exitCode = 0;
    return undefined;
  }
  for (const w of opts.warnings) process.stderr.write(`${tag} warning: ${w}\n`);
  if (opts.errors.length > 0) {
    for (const e of opts.errors) process.stderr.write(`${tag} ${e}\n`);
    process.exitCode = 2;
    return undefined;
  }
  if (opts.bridge || opts.channel) {
    await runBridge(opts, tag);
    return undefined;
  }
  if (opts.transport === 'http') return runHttp(opts, tag);
  await runStdio(opts, tag);
  return undefined;
}

/** Server config both transports share; stdio adds the viewer fields. */
function baseConfig(opts: CliOptions) {
  return { readOnly: opts.readOnly, bsddEndpoint: opts.bsdd, allowedPaths: opts.allowedPaths, samplingEnabled: false };
}

async function loadFiles(registry: ModelRegistry, opts: CliOptions, log: (line: string) => void): Promise<void> {
  for (const [index, file] of opts.files.entries()) {
    // A missing file is named by position, not path: a mistyped value flag
    // (`--tokn secret`) leaves its value here, and stderr reaches client logs.
    if (!existsSync(resolve(file))) {
      throw new Error(`file argument ${index + 1} of ${opts.files.length} does not exist. Check the path, and that no flag is misspelled.`);
    }
    // `arch/model.ifc` and `struct/model.ifc` both derive `model`; suffix the
    // later one so it cannot replace (and dispose) the earlier.
    const base = deriveModelId(basename(file));
    let modelId = base;
    for (let n = 2; registry.get(modelId); n++) modelId = `${base}-${n}`;
    const m = await loadIfcModel(resolve(file), { allowedPaths: opts.allowedPaths, modelId });
    registry.add(m);
    log(`loaded ${m.name} (${m.id}) — ${fmtInt(m.store.entityCount)} entities`);
    for (const w of m.scanWarnings ?? []) log(`warning: ${m.name}: ${w}`);
  }
}

async function runStdio(opts: CliOptions, tag: string): Promise<void> {
  const registry = new InMemoryModelRegistry();
  // Before the first model loads: the engine logs while it works.
  routeConsoleToStderr();
  // stderr only: stdout is the JSON-RPC channel.
  await loadFiles(registry, opts, (line) => process.stderr.write(`${tag} ${line}\n`));

  const server = createMCPServer({
    version: VERSION,
    registry,
    scope: serverScope(opts),
    config: {
      ...baseConfig(opts),
      autoOpenViewer: opts.autoViewer,
      viewerPort: opts.viewerPort,
    },
    logger: {
      log(level, message, data) {
        if (level === 'debug') return;
        process.stderr.write(`${tag} ${level} ${message}${data ? ` ${JSON.stringify(data)}` : ''}\n`);
      },
    },
  });
  const transport = new StdioTransport();
  await transport.connect(server);
  // The peer stopped reading stdout (EPIPE): nothing can be answered, so leave
  // cleanly instead of serving into a dead pipe or dying on an unhandled error.
  transport.onClose((reason) => {
    if (reason !== 'stdout-error') return;
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 1000).unref();
  });
  process.stderr.write(`${tag} ready on stdio (read-only=${opts.readOnly})\n`);

  if (opts.autoViewer && registry.count() > 0) {
    try {
      // Explicit CLI flags (--viewer / --viewer-port) always win, so pass
      // them as the override rather than relying on `server.config` — see
      // `MCPServer.maybeAutoOpenViewer`'s precedence rule.
      const state = await server.maybeAutoOpenViewer({ autoOpen: opts.autoViewer, port: opts.viewerPort });
      if (!state) throw new Error('viewer did not open');
      process.stderr.write(`${tag} viewer ready at ${state.url}\n`);
      if (opts.openBrowser) {
        const cmd = process.platform === 'darwin' ? 'open'
          : process.platform === 'win32' ? 'start'
          : 'xdg-open';
        try {
          const { spawn } = await import('node:child_process');
          spawn(cmd, [state.url], { detached: true, stdio: 'ignore' }).unref();
        } catch (err) {
          process.stderr.write(`${tag} could not auto-open browser: ${(err as Error).message}\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`${tag} viewer auto-open failed: ${(err as Error).message}\n`);
    }
  } else if (registry.count() > 0) {
    process.stderr.write(`${tag} viewer is opt-in. Tell the agent to call \`viewer_ask\` and then \`viewer_open\`, or restart with --viewer to auto-open.\n`);
  }
}

async function runHttp(opts: CliOptions, tag: string): Promise<RunningHttpCli | undefined> {
  // Loopback unless the operator explicitly opts in to a public bind.
  // Combining a public bind with no token requires --insecure so the
  // security tradeoff is a deliberate keystroke, not an accidental
  // copy-paste from a tutorial.
  const host = opts.host ?? '127.0.0.1';
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const tokens = tokenScopes(opts);
  if (!isLoopback && tokens.size === 0 && !opts.insecure) {
    process.stderr.write(`${tag} refusing to bind ${host} without a token. Pass --token <bearer>, --read-only-token <bearer> or --insecure to override.\n`);
    process.exitCode = 1;
    return undefined;
  }
  // Files are not preloaded over HTTP. Every session has its own registry
  // so sessions never share edits, and preloading would mean one full parse
  // and one resident copy per session, which any client could multiply by
  // opening sessions. Warn rather than refuse, so configs written for the
  // old behaviour (files silently ignored) keep starting.
  if (opts.files.length > 0) {
    process.stderr.write(
      // The count, not the values: a mistyped flag (`--tokn secret`) leaves
      // its value here as a positional, and it must not land in a log.
      `${tag} warning: --transport http does not preload files (${opts.files.length} file argument(s) ignored): each session starts empty and the agent ` +
      'loads a model with model_load. Drop the file arguments, and pass --allow <dir> to bound what it can load.\n',
    );
  }
  if (!opts.allowedPaths?.length) {
    process.stderr.write(
      `${tag} warning: no --allow, so model_load (read scope) can open IFC files under the working directory, ` +
      'the temp directory and loaded models\' directories. Pass --allow <dir> to narrow that.\n',
    );
  }
  const sessionFactory: SessionFactory = {
    build(scopeForSession, sessionId) {
      return createMCPServer({
        version: VERSION,
        // Each HTTP session gets a fresh registry so mutations don't leak.
        registry: new InMemoryModelRegistry(),
        scope: scopeForSession,
        // Keys per-session state (layer workspaces) and its disposal (#1030).
        sessionId,
        config: baseConfig(opts),
      });
    },
  };
  const auth: HttpAuthenticator = tokens.size > 0
    ? new BearerTokenAuth(tokens)
    : new AllowAllAuth(anonymousHttpScope(opts));
  const transport = new HttpTransport({
    port: opts.port,
    host,
    authenticator: auth,
    sessionFactory,
    allowedOrigins: opts.allowedOrigins,
  });
  await transport.listen();
  const port = transport.port() ?? opts.port;
  process.stderr.write(
    `${tag} listening on http://${host}:${port}` +
    (tokens.size === 0 ? ' (no auth — loopback only unless --insecure)' : ` (${tokens.size} token${tokens.size === 1 ? '' : 's'})`) +
    '\n',
  );
  return { port, close: () => transport.close() };
}

/** Longest a --bridge shutdown may take, whatever stdout does. */
const SHUTDOWN_DEADLINE_MS = 2000;

async function runBridge(opts: CliOptions, tag: string): Promise<void> {
  const conflict = bridgeConflict(opts);
  if (conflict) {
    process.stderr.write(`${tag} ${conflict}\n`);
    process.exitCode = 2;
    return;
  }
  routeConsoleToStderr();
  const bridgeTag = `${tag.slice(0, -1)} bridge]`;
  const log = (line: string): void => { process.stderr.write(`${bridgeTag} ${line}\n`); };
  const port = opts.bridgePort ?? DEFAULT_BRIDGE_PORT;
  let running: RunningBridge;
  try {
    running = await startBridgeServer({
      version: VERSION,
      port,
      readOnly: opts.readOnly,
      channel: opts.channel,
      viewerUrl: opts.bridgeViewerUrl,
      extraOrigins: opts.allowedOrigins,
      allowInsecureOrigins: opts.insecure,
      log,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const why = e.code === 'EADDRINUSE'
      ? `port ${port} on 127.0.0.1 is in use (another bridge running?). Pass --bridge-port <n>; the pairing link carries the port.`
      : e.message;
    process.stderr.write(`${tag} cannot start the bridge: ${why}\n`);
    process.exitCode = 1;
    return;
  }
  const { server, bridge } = running;
  const transport = new StdioTransport();
  await transport.connect(server);
  // The bridge's listener keeps the process alive, so every way the MCP
  // client can go away (or a signal) closes it and frees the port.
  let stopping = false;
  const stop = (why: string, exitCode: number): void => {
    if (stopping) return;
    stopping = true;
    log(`stopping: ${why}`);
    process.exitCode = exitCode;
    // Armed FIRST, so exit is bounded even if the flush below never completes
    // (a peer that stopped reading leaves stdout full and its callback pending).
    setTimeout(() => process.exit(exitCode), SHUTDOWN_DEADLINE_MS).unref();
    // Normal case: bridge first, so the `shutting-down` answers to pending
    // calls are written and flushed before the transport closes.
    void running.close()
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(() => new Promise<void>((resolve) => process.stdout.write('', () => resolve())))
      .finally(() => {
        transport.close();
        process.stdin.destroy();
      });
  };
  transport.onClose((reason) => { if (reason === 'stdout-error') stop('stdout closed by the MCP client', 0); });
  process.stdin.once('end', () => stop('stdin ended', 0));
  process.stdin.once('close', () => stop('stdin closed', 0));
  process.stdin.once('error', (err) => stop(`stdin error: ${err.message}`, 1));
  process.once('SIGINT', () => stop('SIGINT', 130));
  process.once('SIGTERM', () => stop('SIGTERM', 143));
  const code = bridge.pairingCode();
  log(`ready on stdio; listening on ws://127.0.0.1:${bridge.port} (read-only=${opts.readOnly})`);
  log(`allowed origins (exactly these): ${bridge.allowedOrigins.join(', ')}`);
  log(`to connect a viewer tab open ${bridge.pairingUrl(code)}`);
  log(`or enter the one-time code ${code}. The agent can also call bridge_status for it.`);
}
