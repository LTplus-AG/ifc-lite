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

import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { bridgeConflict, parseArgs, type CliOptions } from './cli-args.js';
import { startBridgeServer, type RunningBridge } from './bridge/run.js';
import { DEFAULT_BRIDGE_PORT, DEFAULT_BRIDGE_VIEWER_URL } from './bridge/protocol.js';
import { StdioTransport } from './transport/stdio.js';
import { routeConsoleToStderr } from './transport/stdio-console.js';
import { HttpTransport, BearerTokenAuth, AllowAllAuth, type HttpAuthenticator, type SessionFactory } from './transport/http.js';
import { createMCPServer, VERSION } from './index.js';
import { loadIfcModel } from './loader.js';
import { fullScope, readOnlyScope, type AuthScope } from './auth/scope.js';
import { InMemoryModelRegistry, type ModelRegistry } from './context.js';
import { fmtInt } from './tools/util.js';

export interface McpCliIdentity {
  /** How the user invoked us, for usage text: `ifc-lite-mcp` or `ifc-lite mcp`. */
  command: string;
}

/** Where Claude Desktop reads its MCP config on `platform`. */
export function claudeDesktopConfigPath(platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform === 'win32') return '%APPDATA%\\Claude\\claude_desktop_config.json';
  return join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

export function mcpHelpText({ command }: McpCliIdentity, platform: NodeJS.Platform = process.platform): string {
  return `
  ${command} v${VERSION} — Model Context Protocol server for ifc-lite

  Usage: ${command} [files…] [options]

  Files are loaded into the session at startup. Over HTTP every session loads
  its own copy, so sessions never share edits.

  Options:
    --read-only             Hide all mutation tools regardless of scope.
                            Models can still be loaded and unloaded.
                            With --bridge: hide and refuse the tools the tab
                            LABELS as mutating; the tab enforces the rest.
    --transport <stdio|http>  Default: stdio.
    --port <n>              HTTP port (default 8765).
    --host <h>              HTTP host. Default 127.0.0.1 (loopback). Use
                            --insecure to allow non-loopback hosts when no
                            token is configured.
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
          "args": ["-y", "@ifc-lite/mcp@^${VERSION}", "/abs/path/to/model.ifc"]
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
  if (opts.bridge || opts.channel) {
    await runBridge(opts, tag);
    return undefined;
  }
  if (opts.transport === 'http') return runHttp(opts, tag);
  if (opts.transport === 'stdio') {
    await runStdio(opts, tag);
    return undefined;
  }
  process.stderr.write(`${tag} unknown transport: ${String(opts.transport)}. Use stdio or http.\n`);
  process.exitCode = 2;
  return undefined;
}

async function loadFiles(registry: ModelRegistry, opts: CliOptions, log: (line: string) => void): Promise<void> {
  for (const file of opts.files) {
    const m = await loadIfcModel(resolve(file), { allowedPaths: opts.allowedPaths });
    registry.add(m);
    log(`loaded ${m.name} (${m.id}) — ${fmtInt(m.store.entityCount)} entities`);
    for (const w of m.scanWarnings ?? []) log(`warning: ${m.name}: ${w}`);
  }
}

async function runStdio(opts: CliOptions, tag: string): Promise<void> {
  const scope: AuthScope = opts.readOnly ? readOnlyScope() : fullScope();
  const registry = new InMemoryModelRegistry();
  // Before the first model loads: the engine logs while it works.
  routeConsoleToStderr();
  // stderr only: stdout is the JSON-RPC channel.
  await loadFiles(registry, opts, (line) => process.stderr.write(`${tag} ${line}\n`));

  const server = createMCPServer({
    version: VERSION,
    registry,
    scope,
    config: {
      readOnly: opts.readOnly,
      bsddEndpoint: opts.bsdd,
      allowedPaths: opts.allowedPaths,
      samplingEnabled: false,
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

/**
 * The bearer tokens `opts` registers, each with its scope. `--token` gets
 * the server's scope; `--read-only-token` gets read scope. A token given
 * under both flags keeps the narrower scope.
 */
export function tokenScopes(opts: Pick<CliOptions, 'tokens' | 'readOnlyTokens' | 'readOnly'>): Map<string, AuthScope> {
  const tokens = new Map<string, AuthScope>();
  for (const t of opts.tokens) tokens.set(t, opts.readOnly ? readOnlyScope() : fullScope());
  for (const t of opts.readOnlyTokens) tokens.set(t, readOnlyScope());
  return tokens;
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
    process.stderr.write(`${tag} refusing to bind ${host} without --token. Pass --token <bearer> or --insecure to override.\n`);
    process.exitCode = 1;
    return undefined;
  }
  // Every session loads the files itself (below). Check they are readable
  // now, so a typo fails at startup rather than on the first connection.
  for (const file of opts.files) {
    const path = resolve(file);
    try {
      await access(path, constants.R_OK);
    } catch (err) {
      throw new Error(`cannot read ${path}: ${(err as Error).message}`);
    }
  }
  const sessionFactory: SessionFactory = {
    async build(scopeForSession, sessionId) {
      // Each HTTP session gets a fresh registry so mutations don't leak.
      const registry = new InMemoryModelRegistry();
      await loadFiles(registry, opts, (line) => process.stderr.write(`${tag} session ${sessionId}: ${line}\n`));
      return createMCPServer({
        version: VERSION,
        registry,
        scope: scopeForSession,
        // Keys per-session state (layer workspaces) and its disposal (#1030).
        sessionId,
        config: {
          readOnly: opts.readOnly,
          bsddEndpoint: opts.bsdd,
          allowedPaths: opts.allowedPaths,
          samplingEnabled: false,
        },
      });
    },
  };
  const auth: HttpAuthenticator = tokens.size > 0
    ? new BearerTokenAuth(tokens)
    : new AllowAllAuth(opts.readOnly ? readOnlyScope() : fullScope());
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
    (opts.files.length > 0 ? `; each session loads ${opts.files.length} file${opts.files.length === 1 ? '' : 's'}` : '') +
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
