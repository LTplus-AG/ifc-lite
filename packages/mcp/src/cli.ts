#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite-mcp` — start an MCP server over stdio (default) or Streamable HTTP.
 *
 * Usage:
 *   ifc-lite-mcp ./model.ifc
 *   ifc-lite-mcp ./arch.ifc ./struct.ifc --federate
 *   ifc-lite-mcp ./model.ifc --read-only
 *   ifc-lite-mcp --transport http --port 8765
 *   ifc-lite-mcp --transport http --port 8765 --token abc123
 *   ifc-lite-mcp --bridge
 *   ifc-lite-mcp ./model.ifc --bridge
 */

import { resolve } from 'node:path';
import { bridgeConflict, parseArgs, type CliOptions } from './cli-args.js';
import { startBridgeServer, type HeadlessParts, type RunningBridge } from './bridge/run.js';
import { isAddrInUse } from './bridge/loopback-server.js';
import { DEFAULT_BRIDGE_PORT, DEFAULT_BRIDGE_VIEWER_URL } from './bridge/protocol.js';
import { StdioTransport } from './transport/stdio.js';
import { routeConsoleToStderr } from './transport/stdio-console.js';
import { HttpTransport, BearerTokenAuth, AllowAllAuth, type HttpAuthenticator, type SessionFactory } from './transport/http.js';
import { createMCPServer, VERSION } from './index.js';
import { loadIfcModel } from './loader.js';
import { fullScope, readOnlyScope, type AuthScope } from './auth/scope.js';
import { InMemoryModelRegistry, type Logger } from './context.js';
import { buildDefaultToolRegistry } from './tools/index.js';
import { buildDefaultResourceRegistry } from './resources/index.js';
import { buildDefaultPromptRegistry } from './prompts/index.js';
import { fmtInt } from './tools/util.js';

function printHelp(): void {
  process.stdout.write(`
  ifc-lite-mcp v${VERSION} — Model Context Protocol server for ifc-lite

  Usage: ifc-lite-mcp [files…] [options]

  Options:
    --read-only             Hide all mutation tools regardless of scope.
                            With --bridge: hide and refuse the tools the tab
                            LABELS as mutating; the tab enforces the rest.
    --federate              Mark explicitly that multiple files form one session.
    --transport <stdio|http>  Default: stdio.
    --port <n>              HTTP port (default 8765).
    --host <h>              HTTP host. Default 127.0.0.1 (loopback). Use
                            --insecure to allow non-loopback hosts when no
                            token is configured.
    --token <t>             Single bearer token for HTTP auth (full scope).
                            Can be repeated to register multiple read-only tokens.
    --insecure              Allow non-loopback bind without authentication.
                            Required when combining a public --host with no
                            --token. NEVER use in production.
                            With --bridge: accept a plain-http origin on a
                            non-loopback host (refused otherwise).
    --bsdd <url>            Override bSDD endpoint.
    --allow <glob>          Restrict file-system access for stdio mode.
    --allow-origin <origin> Permit a browser Origin to read HTTP responses
                            cross-origin (repeatable). Default: none — visited
                            web pages cannot read responses or invoke tools.
                            With --bridge: an extra Origin that may connect.
    --viewer                Auto-open the in-process WebGL viewer at startup.
    --viewer-port <n>       Preferred viewer port (0 = auto).
    --open                  Implies --viewer; also tries to open the URL in
                            the default browser via the OS opener.
    --bridge                Also serve the model open in an ifc-lite browser
                            tab: its tools are added as tab_* once a tab
                            pairs over ws://127.0.0.1. Files and every other
                            tool still work. The agent pairs with the
                            bridge_status tool, which returns the link.
    --bridge-port <n>       Bridge port (default ${DEFAULT_BRIDGE_PORT}, falling back to a
                            free port if taken; an explicit port does not
                            fall back; 0 = any free port).
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
    ifc-lite-mcp ./model.ifc
    ifc-lite-mcp ./arch.ifc ./struct.ifc --federate
    ifc-lite-mcp ./model.ifc --read-only
    ifc-lite-mcp --transport http --port 8765 --token abc
    ifc-lite-mcp --bridge
    ifc-lite-mcp ./model.ifc --bridge

  Claude Desktop config (~/.config/Claude/claude_desktop_config.json):
    {
      "mcpServers": {
        "ifc-lite": {
          "command": "npx",
          "args": ["-y", "@ifc-lite/mcp", "/abs/path/to/model.ifc"]
        }
      }
    }
`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  // `parseArgs` is a pure parser so it can be exercised by tests (and shared
  // with `ifc-lite mcp`); acting on --help/--version stays here, where exiting
  // the process is the caller's business.
  // `process.exitCode` + return, NOT `process.exit(0)`. Writes to a pipe are
  // asynchronous in Node, and `process.exit` does not wait for them, so a large
  // enough piped write can be truncated. This help text is ~2KB and fits the
  // pipe buffer, so it was NOT being truncated today -- measured, not assumed.
  // The change is for the shape rather than an observed failure, and it makes
  // this binary match its sibling `packages/cli/src/index.ts`, which already
  // returns rather than exits.
  if (opts.help) {
    printHelp();
    process.exitCode = 0;
    return;
  }
  if (opts.version) {
    process.stdout.write(`ifc-lite-mcp ${VERSION}\n`);
    process.exitCode = 0;
    return;
  }
  const conflict = bridgeConflict(opts);
  if (conflict) {
    process.stderr.write(`[ifc-lite-mcp] ${conflict}\n`);
    process.exitCode = 2;
    return;
  }
  const scope: AuthScope = !opts.readOnly ? fullScope() : opts.bridge ? bridgeReadOnlyScope() : readOnlyScope();

  const registry = new InMemoryModelRegistry();
  if (opts.transport === 'stdio') {
    // Before the first model loads: the engine logs while it works.
    routeConsoleToStderr();
    const config = {
      readOnly: opts.readOnly,
      bsddEndpoint: opts.bsdd,
      allowedPaths: opts.allowedPaths,
      samplingEnabled: false,
      autoOpenViewer: opts.autoViewer,
      viewerPort: opts.viewerPort,
    };
    const logger: Logger = {
      log(level, message, data) {
        if (level === 'debug') return;
        process.stderr.write(`[ifc-lite-mcp] ${level} ${message}${data ? ` ${JSON.stringify(data)}` : ''}\n`);
      },
    };
    const bridged = opts.bridge
      ? await startBridge(opts, {
        registry, scope, config,
        tools: buildDefaultToolRegistry(), resources: buildDefaultResourceRegistry(), prompts: buildDefaultPromptRegistry(),
      }, logger)
      : null;
    if (opts.bridge && !bridged) return;
    const server = bridged?.server ?? createMCPServer({ version: VERSION, registry, scope, config, logger });
    // After the bridge started, so a bad bridge flag fails before a long load.
    for (const file of opts.files) {
      const m = await loadIfcModel(resolve(file), { allowedPaths: opts.allowedPaths });
      registry.add(m);
      // Use stderr — stdout is sacred for the JSON-RPC channel.
      process.stderr.write(`[ifc-lite-mcp] loaded ${m.name} (${m.id}) — ${fmtInt(m.store.entityCount)} entities\n`);
      for (const w of m.scanWarnings ?? []) process.stderr.write(`[ifc-lite-mcp] warning: ${m.name}: ${w}\n`);
    }
    const transport = new StdioTransport();
    await transport.connect(server);
    if (bridged) {
      stopBridgeWithClient(bridged, transport);
    } else {
      // The peer stopped reading stdout (EPIPE): nothing can be answered, so leave
      // cleanly instead of serving into a dead pipe or dying on an unhandled error.
      transport.onClose((reason) => {
        if (reason !== 'stdout-error') return;
        process.exitCode = 0;
        setTimeout(() => process.exit(0), 1000).unref();
      });
    }
    process.stderr.write(`[ifc-lite-mcp] ready on stdio (read-only=${opts.readOnly}${bridged ? ', browser bridge on' : ''})\n`);
    if (bridged) {
      process.stderr.write('[ifc-lite-mcp] the agent pairs a browser tab with bridge_status, which returns the link.\n');
    }

    if (opts.autoViewer && registry.count() > 0) {
      try {
        // Explicit CLI flags (--viewer / --viewer-port) always win, so pass
        // them as the override rather than relying on `server.config` — see
        // `MCPServer.maybeAutoOpenViewer`'s precedence rule.
        const state = await server.maybeAutoOpenViewer({ autoOpen: opts.autoViewer, port: opts.viewerPort });
        if (!state) throw new Error('viewer did not open');
        process.stderr.write(`[ifc-lite-mcp] viewer ready at ${state.url}\n`);
        if (opts.openBrowser) {
          const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32' ? 'start'
            : 'xdg-open';
          try {
            const { spawn } = await import('node:child_process');
            spawn(cmd, [state.url], { detached: true, stdio: 'ignore' }).unref();
          } catch (err) {
            process.stderr.write(`[ifc-lite-mcp] could not auto-open browser: ${(err as Error).message}\n`);
          }
        }
      } catch (err) {
        process.stderr.write(`[ifc-lite-mcp] viewer auto-open failed: ${(err as Error).message}\n`);
      }
    } else if (registry.count() > 0) {
      process.stderr.write(`[ifc-lite-mcp] viewer is opt-in. Tell the agent to call \`viewer_ask\` and then \`viewer_open\`, or restart with --viewer to auto-open.\n`);
    }
  } else if (opts.transport === 'http') {
    // Pick a safe default. Loopback unless the operator explicitly opts in
    // to a public bind. Combining a public bind with no token requires
    // --insecure so the security tradeoff is a deliberate keystroke, not
    // an accidental copy-paste from a tutorial.
    const host = opts.host ?? '127.0.0.1';
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    if (!isLoopback && !opts.token && !opts.insecure) {
      process.stderr.write(
        `[ifc-lite-mcp] refusing to bind ${host} without --token. Pass --token <bearer> or --insecure to override.\n`,
      );
      process.exit(1);
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
          config: {
            readOnly: opts.readOnly,
            bsddEndpoint: opts.bsdd,
            samplingEnabled: false,
          },
        });
      },
    };
    const auth: HttpAuthenticator = opts.token
      ? new BearerTokenAuth(new Map([[opts.token, scope]]))
      : new AllowAllAuth(scope);
    const transport = new HttpTransport({
      port: opts.port,
      host,
      authenticator: auth,
      sessionFactory,
      allowedOrigins: opts.allowedOrigins,
    });
    await transport.listen();
    process.stderr.write(
      `[ifc-lite-mcp] listening on http://${host}:${opts.port}` +
      (!opts.token ? ' (no auth — loopback only unless --insecure)' : '') +
      '\n',
    );
  } else {
    process.stderr.write(`Unknown transport: ${opts.transport}\n`);
    process.exit(1);
  }
}

/**
 * `--bridge --read-only`: the read-only scopes plus `mutate`, so a mutating
 * tab tool reaches config.readOnly and is refused with READ_ONLY (the code
 * the tab's own read-only grant uses); `admin` stays out.
 */
function bridgeReadOnlyScope(): AuthScope {
  const scope = readOnlyScope();
  scope.scopes.push('mutate');
  return scope;
}

function bridgeLog(line: string): void {
  process.stderr.write(`[ifc-lite-mcp bridge] ${line}\n`);
}

/** Longest a --bridge shutdown may take, whatever stdout does. */
const SHUTDOWN_DEADLINE_MS = 2000;

/** Start the bridge layer on top of the headless parts; null (exit code set) when it cannot start. */
async function startBridge(opts: CliOptions, headless: HeadlessParts, logger: Logger): Promise<RunningBridge | null> {
  // An explicit --bridge-port is a promise to the user: bound at start, no
  // fallback, so a taken one fails here as it always did. Only the default
  // waits for bridge_status and falls back.
  const explicitPort = opts.bridgePort !== undefined;
  try {
    return await startBridgeServer({
      version: VERSION,
      port: opts.bridgePort ?? DEFAULT_BRIDGE_PORT,
      portFallback: !explicitPort,
      lazy: !explicitPort,
      headless,
      readOnly: opts.readOnly,
      channel: opts.channel,
      viewerUrl: opts.bridgeViewerUrl,
      extraOrigins: opts.allowedOrigins,
      allowInsecureOrigins: opts.insecure,
      log: bridgeLog,
      logger,
    });
  } catch (err) {
    const why = explicitPort && isAddrInUse(err)
      ? `port ${opts.bridgePort} on 127.0.0.1 is in use (another bridge running?). Pass another --bridge-port, or drop it to let the bridge pick a free one.`
      : (err as Error).message;
    process.stderr.write(`[ifc-lite-mcp] cannot start the bridge: ${why}\n`);
    process.exitCode = 1;
    return null;
  }
}

/**
 * The bridge's listener keeps the process alive, so every way the MCP client
 * can go away (or a signal) closes it and frees the port.
 */
function stopBridgeWithClient(running: RunningBridge, transport: StdioTransport): void {
  let stopping = false;
  const stop = (why: string, exitCode: number): void => {
    if (stopping) return;
    stopping = true;
    bridgeLog(`stopping: ${why}`);
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
}

main().catch((err: Error) => {
  process.stderr.write(`[ifc-lite-mcp] fatal: ${err.message}\n`);
  if (process.env.DEBUG) process.stderr.write(`${err.stack ?? ''}\n`);
  process.exit(1);
});
