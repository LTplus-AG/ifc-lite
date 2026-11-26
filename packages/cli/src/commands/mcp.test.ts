/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite mcp` runs the same runtime as `ifc-lite-mcp` (#11534): the
 * subcommand answers --help and --version itself, with its own name.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { VERSION } from '@ifc-lite/mcp';
import { mcpCommand } from './mcp.js';

function captureStdout(): () => string {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  return () => out;
}

describe('ifc-lite mcp (#11534)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('prints the shared help under its own name, bridge flags included', async () => {
    const out = captureStdout();
    await mcpCommand(['--help']);
    expect(out()).toContain('Usage: ifc-lite mcp [files…]');
    expect(out()).toContain('--bridge');
    expect(out()).toContain('--read-only-token');
  });

  it('prints the MCP server version', async () => {
    const out = captureStdout();
    await mcpCommand(['--version']);
    expect(out()).toBe(`ifc-lite mcp ${VERSION}\n`);
  });

  it('refuses a bridge combined with HTTP, as the binary does', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await mcpCommand(['--bridge', '--transport', 'http']);
    expect(process.exitCode).toBe(2);
    // The conflict itself, not some other usage error, must be the reason.
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('--bridge speaks MCP over stdio only');
  });
});
