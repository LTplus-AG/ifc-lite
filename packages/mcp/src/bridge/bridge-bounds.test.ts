/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `--bridge` (#9523) schema, number and outbound bounds, from the CodeRabbit
 * review of PR #9905 at 883be2a7bc. Every bridge binds port 0.
 */

import { Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '../protocol/index.js';
import { startBridgeServer, type RunningBridge } from './run.js';
import { BRIDGE_LIMITS, parseTabMessage } from './bridge-protocol.js';
import { READ_TOOL, connectTab, openSocket, pairTab, textResult, type FakeTab } from '../test/bridge-fake-tab.js';

const running: RunningBridge[] = [];
const tabs: FakeTab[] = [];

afterEach(async () => {
  for (const t of tabs.splice(0)) t.ws.terminate();
  for (const r of running.splice(0)) await r.close();
});

async function start() {
  const r = await startBridgeServer({ version: '0', port: 0, readOnly: false, tuning: { callTimeoutMs: 600_000 } });
  running.push(r);
  r.server.attach({ send: () => {} });
  await r.server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  let id = 10;
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> => {
    const res = await r.server.handleMessage({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } });
    return (res as { result: CallToolResult }).result;
  };
  return { r, bridge: r.bridge, call };
}

async function refusal(inputSchema: Record<string, unknown>): Promise<string> {
  const agent = await start();
  const tab = await connectTab({ port: agent.bridge.port, code: agent.bridge.pairingCode(), tools: [{ ...READ_TOOL, inputSchema }] });
  tabs.push(tab);
  return (await tab.next('error')).message;
}

describe('non-finite numbers (CodeRabbit json-bounds.ts:44)', () => {
  it('refuses 1e999 instead of letting it re-serialize as null', () => {
    const frame = '{"type":"result","sessionId":"s","id":"c1","result":{"content":[],"structuredContent":{"count":1e999}}}';
    expect(parseTabMessage(frame)).toEqual({ ok: false, error: 'frame contains a non-finite number' });
  });

  it('fails the call whose result carries one', async () => {
    const agent = await start();
    const p = await pairTab({ port: agent.bridge.port, code: agent.bridge.pairingCode() });
    tabs.push(p.tab);
    const pending = agent.call(READ_TOOL.name);
    const c = await p.tab.next('call');
    p.tab.sendRaw(`{"type":"result","sessionId":"${p.welcome.sessionId}","id":"${c.id}","result":{"content":[],"structuredContent":{"count":-1e999}}}`);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/non-finite number/);
  });
});

describe('schema keywords the bridge cannot enforce (CodeRabbit json-bounds.ts:88, :113)', () => {
  it('refuses a type name validateInput does not enforce, alone or in an array', async () => {
    expect(await refusal({ type: 'object', properties: { n: { type: 'intrger' } } })).toMatch(/properties\.n\.type must be one of string, number, integer/);
    expect(await refusal({ type: 'object', properties: { n: { type: ['string', 'nul'] } } })).toMatch(/type must be one of/);
  });

  it('accepts every type validateInput enforces', async () => {
    const agent = await start();
    const types = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];
    const properties = Object.fromEntries(types.map((t) => [`p_${t}`, { type: t }]));
    const p = await pairTab({ port: agent.bridge.port, code: agent.bridge.pairingCode(), tools: [{ ...READ_TOOL, inputSchema: { type: 'object', properties } }] });
    tabs.push(p.tab);
    expect(p.welcome.sessionId).toBeTruthy();
  });

  it('refuses a schema-valued additionalProperties, which would be published but not enforced', async () => {
    expect(await refusal({ type: 'object', additionalProperties: { type: 'integer' } })).toMatch(/additionalProperties must be true or false/);
  });
});

describe('outbound bounds (CodeRabbit session.ts:124)', () => {
  it('fails a call over maxCallBytes before sending it', async () => {
    const agent = await start();
    const p = await pairTab({ port: agent.bridge.port, code: agent.bridge.pairingCode() });
    tabs.push(p.tab);
    const result = await agent.call(READ_TOOL.name, { type: 'x'.repeat(BRIDGE_LIMITS.maxCallBytes) });
    expect(result.structuredContent).toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'invalid-arguments' } });
    // Prove nothing went out: the next call is the first the tab sees.
    const next = agent.call(READ_TOOL.name, { type: 'IfcWall' });
    const c = await p.tab.next('call');
    expect(c.arguments).toEqual({ type: 'IfcWall' });
    p.tab.reply(p.welcome.sessionId, c.id, textResult('ok'));
    await next;
  });

  it('fails the call past maxPendingCalls at once, without sending it', async () => {
    const agent = await start();
    const p = await pairTab({ port: agent.bridge.port, code: agent.bridge.pairingCode() });
    tabs.push(p.tab);
    const waiting = Array.from({ length: BRIDGE_LIMITS.maxPendingCalls }, () => agent.call(READ_TOOL.name));
    await expect.poll(() => p.tab.calls().length).toBe(BRIDGE_LIMITS.maxPendingCalls);
    const over = await agent.call(READ_TOOL.name);
    expect(over.structuredContent).toMatchObject({ code: 'RATE_LIMITED', details: { reason: 'backpressure' } });
    expect(p.tab.calls()).toHaveLength(BRIDGE_LIMITS.maxPendingCalls);
    for (const c of p.tab.calls()) p.tab.reply(p.welcome.sessionId, c.id, textResult('ok'));
    await Promise.all(waiting);
  });
});

describe('outbound non-finite arguments', () => {
  it('refuses an argument of 1e999 instead of sending it as null', async () => {
    const agent = await start();
    const p = await pairTab({ port: agent.bridge.port, code: agent.bridge.pairingCode(), tools: [{ ...READ_TOOL, inputSchema: { type: 'object' } }] });
    tabs.push(p.tab);
    const result = await agent.call(READ_TOOL.name, JSON.parse('{"count": 1e999}') as Record<string, unknown>);
    expect(result.structuredContent).toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'invalid-arguments' } });
    expect((result.content[0] as { text: string }).text).toMatch(/non-finite number/);
    expect(p.tab.calls()).toEqual([]);
  });
});

describe('slot exhaustion without wrong codes is reported too', () => {
  it('logs the blocked line and counts 429s for sockets held open without a hello', async () => {
    const lines: string[] = [];
    const r = await startBridgeServer({ version: '0', port: 0, readOnly: false, log: (l) => lines.push(l), tuning: { logWindowMs: 60_000 } });
    running.push(r);
    for (let i = 0; i < 4; i++) {
      const o = await openSocket({ port: r.bridge.port, origin: 'https://ifclite.com' });
      if ('tab' in o) tabs.push(o.tab);
    }
    expect(await openSocket({ port: r.bridge.port, origin: 'https://ifclite.com' })).toEqual({ status: 429 });
    expect(r.bridge.pairingStats()).toMatchObject({ failedAttempts: 0, refusedBusy: 1 });
    expect(lines.filter((l) => l.startsWith('pairing is being blocked: every unpaired slot is busy'))).toHaveLength(1);
  });
});

describe('close() (CodeRabbit tab-bridge.ts:196)', () => {
  it('gives every caller the same promise, which resolves only once the port is free', async () => {
    const agent = await start();
    const port = agent.bridge.port;
    const first = agent.bridge.close();
    const second = agent.bridge.close();
    expect(second).toBe(first);
    await second;
    const probe = createNetServer();
    await new Promise<void>((ok, fail) => { probe.once('error', fail); probe.listen(port, '127.0.0.1', () => ok()); });
    await new Promise<void>((ok) => probe.close(() => ok()));
  });

  it('frees the port even without http.Server#closeAllConnections', async () => {
    const own = Object.getOwnPropertyDescriptor(Server.prototype, 'closeAllConnections');
    expect(own).toBeDefined();
    const agent = await start();
    const p = await pairTab({ port: agent.bridge.port, code: agent.bridge.pairingCode() });
    tabs.push(p.tab);
    const port = agent.bridge.port;
    Reflect.deleteProperty(Server.prototype, 'closeAllConnections');
    try {
      await agent.r.close();
    } finally {
      Object.defineProperty(Server.prototype, 'closeAllConnections', own!);
    }
    const probe = createNetServer();
    await new Promise<void>((ok, fail) => { probe.once('error', fail); probe.listen(port, '127.0.0.1', () => ok()); });
    await new Promise<void>((ok) => probe.close(() => ok()));
  });
});
