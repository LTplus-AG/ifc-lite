/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite mcp` — start an MCP server bound to the supplied IFC files.
 *
 * Thin wrapper that delegates to `@ifc-lite/mcp`'s CLI runtime so the
 * surface stays in one place. We accept the same flags as `ifc-lite-mcp`
 * but go through the @ifc-lite/cli help/discovery channel.
 */

import { resolve } from 'node:path';
import {
  StdioTransport,
  HttpTransport,
  BearerTokenAuth,
  AllowAllAuth,
  type HttpAuthenticator,
  type SessionFactory,
  loadIfcModel,
  createMCPServer,
  InMemoryModelRegistry,
  fullScope,
  readOnlyScope,
  type AuthScope,
  VERSION,
} from '@ifc-lite/mcp';
import { fatal, hasFlag, getFlag, getAllFlags } from '../output.js';

export async function mcpCommand(args: string[]): Promise<void> {
  if (args.length === 0 && (process.stdin.isTTY ?? false)) {
    process.stderr.write(
      [
        'Usage: ifc-lite mcp <file.ifc> [more.ifc…] [options]',
        '',
        'Options:',
        '  --read-only            Hide mutation tools.',
        '  --transport stdio|http (default stdio)',
        '  --port <n>             HTTP port (default 8765)',
        '  --token <bearer>       HTTP token for full scope',
        '  --bsdd <url>           Override bSDD endpoint',
        '  --allow <path>         Restrict file-system access',
        '  --viewer               Auto-open the 3D viewer.',
        '  --viewer-port <n>      Preferred viewer port (0 = auto).',
        '  --open                 Auto-open viewer AND open the URL in your browser.',
        '',
        'Examples:',
        '  ifc-lite mcp ./model.ifc',
        '  ifc-lite mcp --read-only ./model.ifc',
        '  ifc-lite mcp --viewer ./model.ifc',
        '  ifc-lite mcp --open ./model.ifc',
        '  ifc-lite mcp --transport http --port 8765 --token abc ./model.ifc',
      ].join('\n') + '\n',
    );
    return;
  }

  const transport = (getFlag(args, '--transport') ?? 'stdio') as 'stdio' | 'http';
  const port = Number(getFlag(args, '--port') ?? 8765);
  const host = getFlag(args, '--host') ?? '0.0.0.0';
  const token = getFlag(args, '--token');
  const bsdd = getFlag(args, '--bsdd');
  const readOnly = hasFlag(args, '--read-only');
  const autoViewer = hasFlag(args, '--viewer') || hasFlag(args, '--open');
  const openBrowser = hasFlag(args, '--open');
  const viewerPort = Number(getFlag(args, '--viewer-port') ?? 0);
  const allowedPaths = getAllFlags(args, '--allow').map((p) => resolve(p));
  const files = args.filter((a) => !a.startsWith('-')).map((a) => resolve(a));
  const scope: AuthScope = readOnly ? readOnlyScope() : fullScope();

  if (transport === 'stdio') {
    if (files.length === 0) fatal('Provide at least one .ifc file (or use --transport http).');
    const registry = new InMemoryModelRegistry();
    for (const file of files) {
      const m = await loadIfcModel(file, { allowedPaths: allowedPaths.length > 0 ? allowedPaths : undefined });
      registry.add(m);
      process.stderr.write(`[ifc-lite mcp] loaded ${m.name} (${m.id})\n`);
    }
    const server = createMCPServer({
      version: VERSION,
      registry,
      scope,
      config: {
        readOnly,
        bsddEndpoint: bsdd,
        allowedPaths: allowedPaths.length > 0 ? allowedPaths : undefined,
        samplingEnabled: false,
        autoOpenViewer: autoViewer,
        viewerPort,
      },
      logger: {
        log(level, message, data) {
          if (level === 'debug') return;
          process.stderr.write(`[ifc-lite mcp] ${level} ${message}${data ? ' ' + JSON.stringify(data) : ''}\n`);
        },
      },
    });
    const t = new StdioTransport();
    await t.connect(server);
    process.stderr.write(`[ifc-lite mcp] ready on stdio (${registry.count()} model${registry.count() === 1 ? '' : 's'}, read-only=${readOnly})\n`);

    if (autoViewer && registry.count() > 0) {
      const first = registry.list()[0];
      try {
        const state = await server.viewer.open(first, viewerPort);
        const adapters = server.viewer.adapters();
        if (adapters) first.backend.attachStreamingAdapters(adapters.viewer, adapters.visibility);
        process.stderr.write(`[ifc-lite mcp] viewer ready at ${state.url}\n`);
        if (openBrowser) {
          const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32' ? 'start'
            : 'xdg-open';
          try {
            const { spawn } = await import('node:child_process');
            spawn(cmd, [state.url], { detached: true, stdio: 'ignore' }).unref();
          } catch (err) {
            process.stderr.write(`[ifc-lite mcp] could not auto-open browser: ${(err as Error).message}\n`);
          }
        }
      } catch (err) {
        process.stderr.write(`[ifc-lite mcp] viewer auto-open failed: ${(err as Error).message}\n`);
      }
    }
  } else if (transport === 'http') {
    const sessionFactory: SessionFactory = {
      build(scopeForSession) {
        return createMCPServer({
          version: VERSION,
          registry: new InMemoryModelRegistry(),
          scope: scopeForSession,
          config: { readOnly, bsddEndpoint: bsdd, samplingEnabled: false },
        });
      },
    };
    const auth: HttpAuthenticator = token
      ? new BearerTokenAuth(new Map([[token, scope]]))
      : new AllowAllAuth(scope);
    const t = new HttpTransport({ port, host, authenticator: auth, sessionFactory });
    await t.listen();
    process.stderr.write(`[ifc-lite mcp] listening on http://${host}:${port}\n`);
  } else {
    fatal(`Unknown transport: ${transport}`);
  }
}
