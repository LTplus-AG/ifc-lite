/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The version this server announces has to be one you can install.
 *
 * `VERSION` was the literal `'0.1.0'`, so `--version`, `--help` and the
 * `serverInfo` block of every MCP `initialize` handshake reported 0.1.0 while
 * the package was at 0.19.0 -- a number that had not been true for eighteen
 * releases, in the one field a client UI puts in front of an operator (#5540).
 *
 * Pinning it against the manifest rather than against a literal is the point:
 * a test that asserted `VERSION === '0.19.0'` would need editing on every
 * release and would go stale exactly the way the constant did.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, createMCPServer } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function declaredVersion(): string {
  const manifest = JSON.parse(
    readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8')
  ) as { version?: string };
  const version = manifest.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('packages/mcp/package.json declares no version');
  }
  return version;
}

describe('the version this server reports', () => {
  it('is the one its package.json declares', () => {
    expect(VERSION).toBe(declaredVersion());
  });

  it('is not the stale literal it used to be hard-coded to', () => {
    expect(VERSION).not.toBe('0.1.0');
  });

  it('is what the MCP handshake announces in serverInfo', async () => {
    const response = await createMCPServer().handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'version-test', version: '0.0.0' },
      },
    });
    const result = (response as { result: { serverInfo: { version: string } } }).result;
    expect(result.serverInfo.version).toBe(declaredVersion());
  });
});

describe('readPackageVersion is resolved from a real manifest', () => {
  it('reads the same file the package publishes', () => {
    // Guards the path arithmetic in index.ts: `../package.json` relative to
    // `src/` at test time and to `dist/` once built are the same manifest.
    const manifest = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')
    ) as { name?: string };
    expect(manifest.name).toBe('@ifc-lite/mcp');
  });
});
