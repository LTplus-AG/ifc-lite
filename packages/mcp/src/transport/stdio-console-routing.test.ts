/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Over stdio, stdout carries JSON-RPC alone, so a `StdioTransport` that owns
 * `process.stdout` points `console.log`, `console.info` and `console.debug`
 * at stderr (#8202). One that writes elsewhere leaves the console alone.
 * Source-level twin of `stdio-stdout-purity.test.ts`, which needs the built
 * server and the wasm bundle.
 */

import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MCPServer } from '../server.js';
import { StdioTransport } from './stdio.js';

const METHODS = ['log', 'info', 'debug'] as const;
const saved = METHODS.map((m) => console[m]);
const server = (): MCPServer => ({ attach: () => undefined, detach: () => undefined }) as unknown as MCPServer;

afterEach(() => {
  METHODS.forEach((m, i) => { console[m] = saved[i]; });
  delete (console as unknown as Record<symbol, unknown>)[Symbol.for('ifc-lite.mcp.console-to-stderr')];
  vi.restoreAllMocks();
});

describe('StdioTransport console routing', () => {
  it('sends console.log, info and debug to stderr when it owns process.stdout', async () => {
    const transport = new StdioTransport({ stdin: new PassThrough() });
    await transport.connect(server());
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    console.log('[IFC-LITE] log');
    console.info('[IFC-LITE] info');
    console.debug('[IFC-LITE] debug');
    expect(error.mock.calls).toEqual([['[IFC-LITE] log'], ['[IFC-LITE] info'], ['[IFC-LITE] debug']]);
    transport.close();
  });

  it('leaves the console alone when stdout is another stream', async () => {
    const transport = new StdioTransport({ stdin: new PassThrough(), stdout: new PassThrough() });
    await transport.connect(server());
    expect(METHODS.map((m) => console[m])).toEqual(saved);
    transport.close();
  });
});
