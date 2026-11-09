/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { StdioTransport } from './stdio.js';
import type { MCPServer } from '../server.js';

it('serializes messages across chunks behind an asynchronous handler (lifecycle audit)', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: string[] = [];
  const server = {
    attach() {}, detach() {},
    async handleMessage(message: { method: string }) {
      seen.push(message.method);
      if (message.method === 'first') await gate;
      return null;
    },
  } as unknown as MCPServer;
  const transport = new StdioTransport({ stdin: input, stdout: output });
  await transport.connect(server);
  input.write('{"jsonrpc":"2.0","method":"first"}\n');
  await new Promise(resolve => setImmediate(resolve));
  input.write('{"jsonrpc":"2.0","method":"second"}\n');
  input.end();
  await new Promise(resolve => setImmediate(resolve));
  try { expect(seen).toEqual(['first']); }
  finally { release(); }
  await new Promise(resolve => setImmediate(resolve));
  expect(seen).toEqual(['first', 'second']);
  transport.close();
});

it('delivers cancellation while an ordered request is pending (lifecycle audit)', async () => {
  const input = new PassThrough();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: string[] = [];
  const server = {
    attach() {}, detach() {},
    async handleMessage(message: { method: string }) {
      seen.push(message.method);
      if (message.method === 'first') await gate;
      if (message.method === 'notifications/cancelled') release();
      return null;
    },
  } as unknown as MCPServer;
  const transport = new StdioTransport({ stdin: input, stdout: new PassThrough() });
  await transport.connect(server);
  input.write('{"jsonrpc":"2.0","id":1,"method":"first"}\n');
  await new Promise(resolve => setImmediate(resolve));
  input.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}\n');
  await new Promise(resolve => setImmediate(resolve));
  try { expect(seen).toEqual(['first', 'notifications/cancelled']); }
  finally { release(); transport.close(); }
});
