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
import { isMcpValueFlag, MCP_SUBCOMMAND_UNSUPPORTED_FLAGS } from '@ifc-lite/mcp/cli-args';
import { fatal, hasFlag, getFlag, getAllFlags } from '../output.js';

/**
 * Collect the positional `.ifc` paths from `ifc-lite mcp`'s argv.
 *
 * The naive `args.filter(a => !a.startsWith('-'))` also catches option VALUES
 * (`8765` after `--port`, `/models` after `--allow`) and turns them into bogus
 * IFC paths, so the walk has to skip each value-bearing flag's next token. It
 * needs a list of which flags those are — and that list used to be a local
 * copy of the standalone `ifc-lite-mcp` binary's flag set.
 *
 * The copy drifted. `--allow-origin` was added to the binary and never here,
 * so `ifc-lite mcp --transport http --allow-origin https://app.example.test
 * model.ifc` skipped the flag, failed to skip the origin, and called
 * `resolve('https://app.example.test')` — loading the origin as a model file.
 * `MCP_VALUE_FLAGS` now comes from `@ifc-lite/mcp/cli-args`, where a test
 * drives the binary's real parser against it.
 *
 * Flags this subcommand cannot act on are reported rather than honoured: their
 * values are still skipped (that is the bug above), but the caller warns
 * instead of letting the user believe the flag took effect.
 */
export function collectModelPaths(args: string[]): { files: string[]; unsupported: string[] } {
  const files: string[] = [];
  const unsupported: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('-')) {
      if (MCP_SUBCOMMAND_UNSUPPORTED_FLAGS.includes(arg)) unsupported.push(arg);
      if (isMcpValueFlag(arg)) i++; // consume the value as well
      continue;
    }
    files.push(resolve(arg));
  }
  return { files, unsupported };
}

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
        '  --host <h>             HTTP host (default 127.0.0.1; non-loopback requires --token or --insecure)',
        '  --token <bearer>       HTTP token for full scope',
        '  --insecure             Allow non-loopback bind without --token (DEV ONLY)',
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
  const host = getFlag(args, '--host');
  const token = getFlag(args, '--token');
  const bsdd = getFlag(args, '--bsdd');
  const readOnly = hasFlag(args, '--read-only');
  const insecure = hasFlag(args, '--insecure');
  const autoViewer = hasFlag(args, '--viewer') || hasFlag(args, '--open');
  const openBrowser = hasFlag(args, '--open');
  const viewerPort = Number(getFlag(args, '--viewer-port') ?? 0);
  const allowedPaths = getAllFlags(args, '--allow').map((p) => resolve(p));
  const { files, unsupported } = collectModelPaths(args);
  for (const flag of unsupported) {
    process.stderr.write(
      `[ifc-lite mcp] ${flag} is not honoured by this subcommand — run the standalone \`ifc-lite-mcp\` binary for it.\n`,
    );
  }
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
    const resolvedHost = host ?? '127.0.0.1';
    const isLoopback = resolvedHost === '127.0.0.1' || resolvedHost === 'localhost' || resolvedHost === '::1';
    if (!isLoopback && !token && !insecure) {
      fatal(`Refusing to bind ${resolvedHost} without --token. Pass --token <bearer> or --insecure to override.`);
    }
    const sessionFactory: SessionFactory = {
      build(scopeForSession, sessionId) {
        return createMCPServer({
          version: VERSION,
          registry: new InMemoryModelRegistry(),
          scope: scopeForSession,
          // Keys per-session state (layer workspaces) and its disposal
          // (#1030); the transport rejects servers built without it.
          sessionId,
          config: {
            readOnly,
            bsddEndpoint: bsdd,
            allowedPaths: allowedPaths.length > 0 ? allowedPaths : undefined,
            samplingEnabled: false,
          },
        });
      },
    };
    const auth: HttpAuthenticator = token
      ? new BearerTokenAuth(new Map([[token, scope]]))
      : new AllowAllAuth(scope);
    const t = new HttpTransport({ port, host: resolvedHost, authenticator: auth, sessionFactory });
    await t.listen();
    process.stderr.write(
      `[ifc-lite mcp] listening on http://${resolvedHost}:${port}` +
      (!token ? ' (no auth — loopback only unless --insecure)' : '') +
      '\n',
    );
  } else {
    fatal(`Unknown transport: ${transport}`);
  }
}
