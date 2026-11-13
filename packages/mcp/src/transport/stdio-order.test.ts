/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { StdioTransport } from './stdio.js';
import type { MCPServer } from '../server.js';
import type { JsonRpcMessage, JsonRpcResponse } from '../protocol/index.js';

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(handleMessage: (message: JsonRpcMessage) => Promise<JsonRpcResponse | null>, detach = () => {}) {
  const input = new PassThrough(), output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += String(chunk); });
  const transport = new StdioTransport({ stdin: input, stdout: output });
  await transport.connect({ attach() {}, detach, handleMessage } as unknown as MCPServer);
  return { transport, input,
    send(message: JsonRpcMessage) { input.write(JSON.stringify(message) + '\n'); },
    ids() { return text.trim().split('\n').filter(Boolean).map(line => (JSON.parse(line) as JsonRpcResponse).id); },
  };
}

it('#9537 answers ping in a later chunk while a tool call is still running', async () => {
  const slow = gate();
  const f = await fixture(async message => {
    if (!('id' in message) || !('method' in message)) return null;
    if (message.id === 1) await slow.promise;
    return { jsonrpc: '2.0', id: message.id, result: {} };
  });
  try {
    f.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'viewer_wait_for_selection' } });
    await tick();
    f.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await tick();
    expect(f.ids()).toEqual([2]);
    slow.release(); await tick();
    expect(f.ids()).toEqual([2, 1]);
  } finally { slow.release(); f.transport.close(); }
});

it('#9537 writes initialize response before dispatching dependent requests', async () => {
  const init = gate();
  const seen: string[] = [];
  const f = await fixture(async message => {
    if (!('method' in message) || !('id' in message)) return null;
    seen.push(message.method);
    if (message.method === 'initialize') await init.promise;
    return { jsonrpc: '2.0', id: message.id, result: {} };
  });
  try {
    f.send({ jsonrpc: '2.0', id: 0, method: 'initialize' });
    f.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await tick(); expect(seen).toEqual(['initialize']); expect(f.ids()).toEqual([]);
    init.release(); await tick(); expect(f.ids()).toEqual([0, 1]);
  } finally { init.release(); f.transport.close(); }
});

it('#9537 cancels a request waiting for initialization before it registers as active', async () => {
  const init = gate();
  const seen: number[] = [];
  const f = await fixture(async message => {
    if (!('method' in message) || !('id' in message)) return null;
    seen.push(Number(message.id));
    if (message.method === 'initialize') await init.promise;
    return { jsonrpc: '2.0', id: message.id, result: {} };
  });
  try {
    f.send({ jsonrpc: '2.0', id: 0, method: 'initialize' });
    f.send({ jsonrpc: '2.0', id: 3, method: 'tools/call' });
    f.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } });
    f.send({ jsonrpc: '2.0', id: 4, method: 'ping' });
    init.release(); await tick();
    expect(seen).toEqual([0, 4]); expect(f.ids()).toEqual([0, 4]);
  } finally { init.release(); f.transport.close(); }
});

it('#9537 detaches immediately at EOF even when an in-flight handler is hung', async () => {
  const slow = gate(); let detached = false;
  const f = await fixture(async () => { await slow.promise; return null; }, () => { detached = true; slow.release(); });
  try {
    f.send({ jsonrpc: '2.0', id: 1, method: 'tools/call' }); await tick();
    f.input.end(); await tick(); expect(detached).toBe(true);
  } finally { slow.release(); f.transport.close(); }
});

it('#9537 does not dispatch handshake-waiting requests after EOF', async () => {
  const init = gate(); const seen: string[] = [];
  const f = await fixture(async message => {
    if ('method' in message) { seen.push(message.method); await init.promise; }
    return null;
  });
  try {
    f.send({ jsonrpc: '2.0', id: 0, method: 'initialize' });
    f.send({ jsonrpc: '2.0', id: 1, method: 'tools/call' });
    f.input.end(); await tick();
    expect(f.transport['waitingRequests'].size).toBe(0);
    init.release(); await tick();
    expect(seen).toEqual(['initialize']);
  } finally { init.release(); f.transport.close(); }
});

it('#9537 a cancelled queued id can be reused without resurrecting its old request', async () => {
  const init = gate(); const seen: string[] = [];
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(async message => {
    if (!('method' in message) || !('id' in message)) return null;
    if (message.method === 'initialize') await init.promise;
    else if (message.method === 'ping') f.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } });
    else seen.push((message.params as { tag: string }).tag);
    return { jsonrpc: '2.0', id: message.id, result: {} };
  });
  try {
    f.send({ jsonrpc: '2.0', id: 0, method: 'initialize' });
    f.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { tag: 'old' } });
    f.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } });
    f.send({ jsonrpc: '2.0', id: 4, method: 'ping' });
    f.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { tag: 'new' } });
    init.release(); await tick(); expect(seen).toEqual([]);
  } finally { init.release(); f.transport.close(); }
});

it('#9537 close refuses further input without retaining more queued requests', async () => {
  const init = gate();
  const f = await fixture(async () => { await init.promise; return null; });
  try {
    f.send({ jsonrpc: '2.0', id: 0, method: 'initialize' });
    f.transport.close();
    f.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(f.transport['waitingRequests'].size).toBe(0);
  } finally { init.release(); f.transport.close(); }
});

it('#9537 an earlier initialize response cannot release a later initialization barrier', async () => {
  const first = gate(), second = gate(); const seen: string[] = []; let starts = 0;
  const f = await fixture(async message => {
    if (!('method' in message) || !('id' in message)) return null;
    seen.push(message.method);
    if (message.method === 'initialize') await (++starts === 1 ? first.promise : second.promise);
    return { jsonrpc: '2.0', id: message.id, result: {} };
  });
  try {
    f.send({ jsonrpc: '2.0', id: 0, method: 'initialize' });
    f.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    first.release(); await tick();
    f.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await tick(); expect(seen).toEqual(['initialize', 'initialize']);
    second.release(); await tick(); expect(f.ids()).toEqual([0, 1, 2]);
  } finally { first.release(); second.release(); f.transport.close(); }
});
