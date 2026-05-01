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
 */

import { resolve } from 'node:path';
import { StdioTransport } from './transport/stdio.js';
import { HttpTransport, BearerTokenAuth, AllowAllAuth, type HttpAuthenticator, type SessionFactory } from './transport/http.js';
import { createMCPServer, VERSION } from './index.js';
import { loadIfcModel } from './loader.js';
import { fullScope, readOnlyScope, type AuthScope } from './auth/scope.js';
import { InMemoryModelRegistry } from './context.js';

interface CliOptions {
  files: string[];
  readOnly: boolean;
  federate: boolean;
  transport: 'stdio' | 'http';
  port: number;
  host: string;
  token?: string;
  bsdd?: string;
  allowedPaths?: string[];
  autoViewer: boolean;
  viewerPort: number;
  openBrowser: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    files: [],
    readOnly: false,
    federate: false,
    transport: 'stdio',
    port: 8765,
    host: '0.0.0.0',
    autoViewer: false,
    viewerPort: 0,
    openBrowser: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--read-only') opts.readOnly = true;
    else if (arg === '--federate') opts.federate = true;
    else if (arg === '--transport') opts.transport = (argv[++i] as 'stdio' | 'http') ?? 'stdio';
    else if (arg === '--port') opts.port = Number(argv[++i] ?? 8765);
    else if (arg === '--host') opts.host = argv[++i] ?? '0.0.0.0';
    else if (arg === '--token') opts.token = argv[++i];
    else if (arg === '--bsdd') opts.bsdd = argv[++i];
    else if (arg === '--viewer') opts.autoViewer = true;
    else if (arg === '--viewer-port') opts.viewerPort = Number(argv[++i] ?? 0);
    else if (arg === '--open') { opts.autoViewer = true; opts.openBrowser = true; }
    else if (arg === '--allow') {
      const path = argv[++i];
      if (path) (opts.allowedPaths ??= []).push(resolve(path));
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--version' || arg === '-v') {
      process.stdout.write(`ifc-lite-mcp ${VERSION}\n`);
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      opts.files.push(arg);
    }
  }
  return opts;
}

function printHelp(): void {
  process.stdout.write(`
  ifc-lite-mcp v${VERSION} — Model Context Protocol server for ifc-lite

  Usage: ifc-lite-mcp [files…] [options]

  Options:
    --read-only             Hide all mutation tools regardless of scope.
    --federate              Mark explicitly that multiple files form one session.
    --transport <stdio|http>  Default: stdio.
    --port <n>              HTTP port (default 8765).
    --host <h>              HTTP host (default 0.0.0.0).
    --token <t>             Single bearer token for HTTP auth (full scope).
                            Can be repeated to register multiple read-only tokens.
    --bsdd <url>            Override bSDD endpoint.
    --allow <glob>          Restrict file-system access for stdio mode.
    --viewer                Auto-open the in-process WebGL viewer at startup.
    --viewer-port <n>       Preferred viewer port (0 = auto).
    --open                  Implies --viewer; also tries to open the URL in
                            the default browser via the OS opener.
    --version, -v           Print version.
    --help, -h              This message.

  Examples:
    ifc-lite-mcp ./model.ifc
    ifc-lite-mcp ./arch.ifc ./struct.ifc --federate
    ifc-lite-mcp ./model.ifc --read-only
    ifc-lite-mcp --transport http --port 8765 --token abc

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
  const scope: AuthScope = opts.readOnly ? readOnlyScope() : fullScope();

  const registry = new InMemoryModelRegistry();
  if (opts.transport === 'stdio') {
    for (const file of opts.files) {
      const m = await loadIfcModel(resolve(file), { allowedPaths: opts.allowedPaths });
      registry.add(m);
      // Use stderr — stdout is sacred for the JSON-RPC channel.
      process.stderr.write(`[ifc-lite-mcp] loaded ${m.name} (${m.id}) — ${m.store.entityCount.toLocaleString()} entities\n`);
    }

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
          process.stderr.write(`[ifc-lite-mcp] ${level} ${message}${data ? ` ${JSON.stringify(data)}` : ''}\n`);
        },
      },
    });
    const transport = new StdioTransport();
    await transport.connect(server);
    process.stderr.write(`[ifc-lite-mcp] ready on stdio (read-only=${opts.readOnly})\n`);

    if (opts.autoViewer && registry.count() > 0) {
      const first = registry.list()[0];
      try {
        const state = await server.viewer.open(first, opts.viewerPort);
        const adapters = server.viewer.adapters();
        if (adapters) first.backend.attachStreamingAdapters(adapters.viewer, adapters.visibility);
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
    const sessionFactory: SessionFactory = {
      build(scopeForSession) {
        return createMCPServer({
          version: VERSION,
          // Each HTTP session gets a fresh registry so mutations don't leak.
          registry: new InMemoryModelRegistry(),
          scope: scopeForSession,
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
    const transport = new HttpTransport({ port: opts.port, host: opts.host, authenticator: auth, sessionFactory });
    await transport.listen();
    process.stderr.write(`[ifc-lite-mcp] listening on http://${opts.host}:${opts.port}\n`);
  } else {
    process.stderr.write(`Unknown transport: ${opts.transport}\n`);
    process.exit(1);
  }
}

main().catch((err: Error) => {
  process.stderr.write(`[ifc-lite-mcp] fatal: ${err.message}\n`);
  if (process.env.DEBUG) process.stderr.write(`${err.stack ?? ''}\n`);
  process.exit(1);
});
