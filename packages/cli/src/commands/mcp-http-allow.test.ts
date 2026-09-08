/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #2731: `mcp --allow` is enforced under the default stdio transport
 * via `buildAllowedRoots` (packages/mcp/src/safe-path.ts), which reads
 * `ctx.config.allowedPaths`. Under `--transport http`, the per-session
 * config built in `mcpCommand` must carry the same `allowedPaths` so the
 * flag means the same thing on both transports.
 *
 * Spinning a real HTTP listener and driving a full MCP session through it
 * from this suite would require plumbing the ephemeral bound port back out
 * of `mcpCommand` (it never exposes the `HttpTransport` instance), so this
 * test targets the config-construction seam directly: it captures the
 * `SessionFactory` handed to `HttpTransport` and asserts the config it
 * builds for a session includes `allowedPaths`. This is a seam test, not
 * an end-to-end demonstration that a request for a disallowed path is
 * actually refused.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';

const createMCPServerMock = vi.fn((opts: unknown) => ({ __opts: opts }));
let capturedSessionFactory: { build: (scope: unknown, sessionId: string) => unknown } | undefined;

vi.mock('@ifc-lite/mcp', () => ({
  StdioTransport: class {
    connect = vi.fn(async () => {});
  },
  HttpTransport: class {
    constructor(opts: { sessionFactory: { build: (scope: unknown, sessionId: string) => unknown } }) {
      capturedSessionFactory = opts.sessionFactory;
    }
    listen = vi.fn(async () => {});
  },
  BearerTokenAuth: class {
    constructor(public map: unknown) {}
  },
  AllowAllAuth: class {
    constructor(public scope: unknown) {}
  },
  loadIfcModel: vi.fn(),
  createMCPServer: createMCPServerMock,
  InMemoryModelRegistry: class {
    add() {}
    list() {
      return [];
    }
    count() {
      return 0;
    }
  },
  fullScope: () => ({ scopes: ['read', 'mutate'] }),
  readOnlyScope: () => ({ scopes: ['read'] }),
  VERSION: '0.0.0-test',
}));

describe('mcp --allow under --transport http (#2731)', () => {
  beforeEach(() => {
    createMCPServerMock.mockClear();
    capturedSessionFactory = undefined;
  });

  it('carries allowedPaths into the per-session config, same as stdio', async () => {
    const { mcpCommand } = await import('./mcp.js');

    const allowedDir = resolve('/tmp/ifc-lite-allow-test-dir');
    await mcpCommand(['--transport', 'http', '--port', '0', '--allow', allowedDir]);

    expect(capturedSessionFactory).toBeDefined();
    // Building a session is exactly what happens on the first HTTP request.
    capturedSessionFactory!.build({ scopes: ['read', 'mutate'] }, 'test-session-1');

    expect(createMCPServerMock).toHaveBeenCalledTimes(1);
    const config = (createMCPServerMock.mock.calls[0][0] as { config?: { allowedPaths?: string[] } }).config;

    // This is the assertion that fails before the fix: the http session
    // config drops `allowedPaths` entirely, so `--allow` under http falls
    // back to the server's broader implicit allowlist (loaded-model dirs +
    // process.cwd() + os.tmpdir()) instead of restricting to `allowedDir`.
    expect(config?.allowedPaths).toEqual([allowedDir]);
  });
});
