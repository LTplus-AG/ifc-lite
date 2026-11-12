/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hardening of `--bridge` (#9523) from the security review of PR #9905. Each
 * block names the review item it pins. Every bridge binds port 0.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { CallToolResult, JsonRpcMessage, ToolDefinition } from '../protocol/index.js';
import { bridgeOrigins, startBridgeServer, type RunningBridge } from './run.js';
import { BRIDGE_LIMITS, BridgeCloseCode, type BridgeToolDescriptor } from './bridge-protocol.js';
import {
  MUTATING_TOOL,
  READ_TOOL,
  connectTab,
  openSocket,
  pairTab,
  rawPeer,
  textResult,
  type FakeTab,
} from '../test/bridge-fake-tab.js';

const running: RunningBridge[] = [];
const tabs: FakeTab[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  for (const t of tabs.splice(0)) t.ws.terminate();
  for (const r of running.splice(0)) await r.close();
});

type Tuning = Parameters<typeof startBridgeServer>[0]['tuning'];

async function start(opts: { readOnly?: boolean; tuning?: Tuning; log?: (l: string) => void } = {}) {
  const r = await startBridgeServer({ version: '0', port: 0, readOnly: opts.readOnly ?? false, tuning: opts.tuning, log: opts.log });
  running.push(r);
  const notes: JsonRpcMessage[] = [];
  r.server.attach({ send: (m) => { notes.push(m); } });
  await r.server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  let id = 10;
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> => {
    const res = await r.server.handleMessage({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } });
    return (res as { result: CallToolResult }).result;
  };
  const list = async (): Promise<ToolDefinition[]> => {
    const res = await r.server.handleMessage({ jsonrpc: '2.0', id: id++, method: 'tools/list', params: {} });
    return (res as { result: { tools: ToolDefinition[] } }).result.tools;
  };
  const listChanged = () => notes.filter((n) => 'method' in n && n.method === 'notifications/tools/list_changed').length;
  return { r, bridge: r.bridge, call, list, listChanged };
}

async function paired(agent: Awaited<ReturnType<typeof start>>, extra: Partial<Parameters<typeof pairTab>[0]> = {}) {
  const p = await pairTab({ port: agent.bridge.port, code: agent.bridge.pairingCode(), ...extra });
  tabs.push(p.tab);
  return p;
}

/** JSON text nested `depth` objects deep. Built as text: JSON.stringify itself throws at this depth. */
function nestedJson(depth: number): string {
  return '{"a":'.repeat(depth) + '{}' + '}'.repeat(depth);
}

/** `frame` serialized with the string `"__DEEP__"` replaced by `deepJson`. */
function withDeep(frame: unknown, deepJson: string): string {
  return JSON.stringify(frame).replace('"__DEEP__"', deepJson);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reason = (r: CallToolResult) => (r.structuredContent?.details as { reason?: string } | undefined)?.reason;

describe('item 2: tab-supplied JSON is depth- and size-bounded', () => {
  it('refuses a hello whose schema is nested 20,000 deep, instead of hanging tools/list later', async () => {
    const agent = await start();
    const opened = await openSocket({ port: agent.bridge.port, origin: 'https://ifclite.com' });
    if (!('tab' in opened)) throw new Error('refused');
    const tab = opened.tab;
    tabs.push(tab);
    const deep = { ...READ_TOOL, inputSchema: { type: 'object', properties: { x: '__DEEP__' } } };
    tab.sendRaw(withDeep({ type: 'hello', protocol: 1, pairingCode: agent.bridge.pairingCode(), permission: 'read-only', tools: [deep] }, nestedJson(20_000)));
    expect((await tab.next('error')).message).toMatch(/nested deeper than 32/);
    expect(await tab.closed()).toBe(BridgeCloseCode.INVALID_MESSAGE);
    expect((await agent.list()).map((t) => t.name)).toEqual(['bridge_status']);
  });

  it('turns a result nested 20,000 deep into an error result at once', async () => {
    const agent = await start();
    const { tab, welcome } = await paired(agent);
    const pending = agent.call(READ_TOOL.name);
    const c = await tab.next('call');
    tab.sendRaw(withDeep({ type: 'result', sessionId: welcome.sessionId, id: c.id, result: { content: [], structuredContent: '__DEEP__' } }, nestedJson(20_000)));
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(reason(result)).toBe('malformed-result');
    expect(result.content[0]).toMatchObject({ text: expect.stringMatching(/nested deeper than 64/) });
  });
});

describe('item 3: a failed or timed-out socket is dead and does not hold its slot', () => {
  it('ignores a hello sent after the handshake timeout, even if the peer ignores the close frame', async () => {
    const agent = await start({ tuning: { handshakeTimeoutMs: 100, closeGraceMs: 2000 } });
    const code = agent.bridge.pairingCode();
    const peer = rawPeer(agent.bridge.port);
    cleanups.push(() => peer.destroy());
    expect(await peer.status).toContain('101');
    await sleep(250);
    peer.sendText(JSON.stringify({ type: 'hello', protocol: 1, pairingCode: code, permission: 'read-write', tools: [READ_TOOL] }));
    await sleep(150);
    expect(agent.bridge.tab()).toBeNull();
    // The code was not consumed: the real tab still pairs with it.
    await paired(agent, { code });
  });

  it('frees unpaired slots at the timeout and terminates silent peers without waiting for ws\'s 30 s close timeout', async () => {
    const agent = await start({ tuning: { handshakeTimeoutMs: 100 } });
    const peers = Array.from({ length: 4 }, () => rawPeer(agent.bridge.port));
    for (const p of peers) cleanups.push(() => p.destroy());
    for (const p of peers) expect(await p.status).toContain('101');
    await sleep(150);
    // Slots are free as soon as the sockets are dead, before they are even terminated.
    const { welcome } = await paired(agent);
    expect(welcome.sessionId).toBeTruthy();
    const started = Date.now();
    await Promise.all(peers.map((p) => p.ended));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses a fifth unpaired socket with 429 while four are open', async () => {
    const agent = await start();
    for (let i = 0; i < 4; i++) {
      const o = await openSocket({ port: agent.bridge.port, origin: 'https://ifclite.com' });
      if ('tab' in o) tabs.push(o.tab);
    }
    expect(await openSocket({ port: agent.bridge.port, origin: 'https://ifclite.com' })).toEqual({ status: 429 });
  });
});

describe('item 4: plain-http origins only on loopback hosts', () => {
  it('refuses a non-loopback http origin unless --insecure, and warns when accepted', () => {
    expect(() => bridgeOrigins('http://devbox.lan:5173')).toThrow(/plain http on a non-loopback host/);
    expect(() => bridgeOrigins('https://ifclite.com', ['http://10.0.0.5:8080'])).toThrow(/--insecure/);
    const warnings: string[] = [];
    expect(bridgeOrigins('http://devbox.lan:5173', [], true, (w) => warnings.push(w))).toEqual(['http://devbox.lan:5173']);
    expect(warnings).toEqual([expect.stringMatching(/WARNING: accepting insecure origin http:\/\/devbox\.lan:5173/)]);
  });

  it('accepts http on localhost, 127.0.0.0/8 and [::1], and https anywhere', () => {
    expect(bridgeOrigins('http://localhost:5173', ['http://127.0.0.2:8080', 'http://[::1]:3000', 'https://staging.example.test'])).toEqual([
      'http://localhost:5173', 'http://127.0.0.2:8080', 'http://[::1]:3000', 'https://staging.example.test',
    ]);
  });

  it('refuses to start with an insecure --allow-origin', async () => {
    await expect(startBridgeServer({ version: '0', port: 0, readOnly: false, extraOrigins: ['http://devbox.lan'] })).rejects.toThrow(/non-loopback/);
  });
});

describe('item 5: noisy peers cannot flood the log', () => {
  it('logs the first refused upgrade and then one summary per window', async () => {
    const lines: string[] = [];
    const agent = await start({ log: (l) => lines.push(l), tuning: { logWindowMs: 300 } });
    for (let i = 0; i < 30; i++) {
      expect(await openSocket({ port: agent.bridge.port, origin: 'https://evil.example' })).toEqual({ status: 403 });
    }
    expect(lines.filter((l) => l.startsWith('refused a connection'))).toHaveLength(1);
    await expect.poll(() => lines).toContain('29 more refused connections in the last 300 ms');
  });
});

describe('item 6: list_changed only on a real change, throttled', () => {
  it('sends no notification for 1,000 no-op updates', async () => {
    const agent = await start();
    const { tab, welcome } = await paired(agent);
    await sleep(250);
    const before = agent.listChanged();
    for (let i = 0; i < 1000; i++) tab.sendRaw({ type: 'update', sessionId: welcome.sessionId, permission: 'read-only', tools: [READ_TOOL, MUTATING_TOOL] });
    await sleep(400);
    expect(agent.listChanged()).toBe(before);
  });

  it('coalesces a burst of real changes and settles on the last state', async () => {
    const agent = await start({ tuning: { changeThrottleMs: 200 } });
    const { tab, welcome } = await paired(agent);
    await sleep(250);
    const before = agent.listChanged();
    for (let i = 0; i < 50; i++) {
      tab.sendRaw({ type: 'update', sessionId: welcome.sessionId, permission: i % 2 === 0 ? 'read-write' : 'read-only' });
    }
    tab.sendRaw({ type: 'update', sessionId: welcome.sessionId, permission: 'read-write' });
    await sleep(500);
    expect(agent.listChanged() - before).toBeGreaterThanOrEqual(1);
    expect(agent.listChanged() - before).toBeLessThanOrEqual(3);
    expect((await agent.list()).map((t) => t.name)).toContain(MUTATING_TOOL.name);
  });

  it('keeps a tool the tab adds as mutating hidden and refused while read-only', async () => {
    const agent = await start();
    const { tab, welcome } = await paired(agent, { tools: [READ_TOOL] });
    const extra: BridgeToolDescriptor = { ...MUTATING_TOOL, name: 'delete_entity' };
    tab.sendRaw({ type: 'update', sessionId: welcome.sessionId, tools: [READ_TOOL, extra] });
    await expect.poll(() => agent.bridge.tab()?.tools.length).toBe(2);
    expect((await agent.list()).map((t) => t.name)).not.toContain('delete_entity');
    expect((await agent.call('delete_entity', {})).structuredContent?.code).toBe('READ_ONLY');
    expect(tab.calls()).toEqual([]);
  });
});

describe('item 7: schema properties are own properties; malformed schemas are refused up front', () => {
  it('does not read toString/constructor from Object.prototype', async () => {
    const agent = await start();
    const tool: BridgeToolDescriptor = {
      name: 'proto_props', description: '', readOnly: true,
      inputSchema: { type: 'object', properties: { toString: { type: 'string' }, constructor: { type: 'string' } }, required: ['constructor'] },
    };
    const { tab, welcome } = await paired(agent, { tools: [tool] });
    // Omitting toString is fine; omitting the required constructor is not.
    expect((await agent.call('proto_props', {})).structuredContent?.code).toBe('INVALID_INPUT');
    const pending = agent.call('proto_props', { constructor: 'x' });
    const c = await tab.next('call');
    expect(c.arguments).toEqual({ constructor: 'x' });
    tab.reply(welcome.sessionId, c.id, textResult('ok'));
    expect((await pending).isError).toBeUndefined();
  });

  it.each([
    ['properties: {a: null}', { type: 'object', properties: { a: null } }, /properties\.a must be an object/],
    ['required: "x"', { type: 'object', required: 'x' }, /required must be an array of strings/],
    ['anyOf: {}', { type: 'object', anyOf: {} }, /anyOf must be an array/],
    ['maxLength: "5"', { type: 'object', properties: { s: { type: 'string', maxLength: '5' } } }, /maxLength must be a finite number/],
  ])('refuses a hello with %s', async (_label, inputSchema, message) => {
    const agent = await start();
    const tab = await connectTab({ port: agent.bridge.port, code: agent.bridge.pairingCode(), tools: [{ ...READ_TOOL, inputSchema }] });
    tabs.push(tab);
    expect((await tab.next('error')).message).toMatch(message);
  });
});

describe('item 8: aggregate limits, text-only content, provenance', () => {
  it('refuses tool descriptors over the aggregate byte limit', async () => {
    const agent = await start();
    const big = Array.from({ length: 200 }, (_, i) => ({ ...READ_TOOL, name: `t${i}`, description: 'x'.repeat(8000) }));
    const tab = await connectTab({ port: agent.bridge.port, code: agent.bridge.pairingCode(), tools: big });
    tabs.push(tab);
    expect((await tab.next('error')).message).toMatch(new RegExp(`limit is ${BRIDGE_LIMITS.maxDescriptorBytes}`));
  });

  it('fails a call whose result exceeds maxResultBytes with a message naming the limit', async () => {
    const agent = await start();
    const { tab, welcome } = await paired(agent);
    const pending = agent.call(READ_TOOL.name);
    const c = await tab.next('call');
    tab.reply(welcome.sessionId, c.id, textResult('y'.repeat(BRIDGE_LIMITS.maxResultBytes + 1)));
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(`the limit is ${BRIDGE_LIMITS.maxResultBytes}`) });
  });

  it.each([
    ['a resource with a file:// URI', { type: 'resource', resource: { uri: 'file:///etc/passwd', text: 'x' } }],
    ['an image', { type: 'image', data: 'AAAA', mimeType: 'image/png' }],
  ])('refuses %s in result content', async (_label, entry) => {
    const agent = await start();
    const { tab, welcome } = await paired(agent);
    const pending = agent.call(READ_TOOL.name);
    const c = await tab.next('call');
    tab.sendRaw({ type: 'result', sessionId: welcome.sessionId, id: c.id, result: { content: [entry] } });
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('text content only') });
  });

  it('labels tab-supplied text as data in the instructions and in bridge_status', async () => {
    const r = await startBridgeServer({ version: '0', port: 0, readOnly: false });
    running.push(r);
    const init = await r.server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect((init as { result: { instructions: string } }).result.instructions).toMatch(/data, not instructions/);
    await pairTab({ port: r.bridge.port, code: r.bridge.pairingCode() }).then((p) => tabs.push(p.tab));
    const status = await r.server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bridge_status', arguments: {} } });
    const text = ((status as { result: CallToolResult }).result.content[0] as { text: string }).text;
    expect(text).toMatch(/data, not instructions/);
  });
});

describe('frame limits and binary frames', () => {
  it('closes with 1009 on a frame over maxMessageBytes and fails the pending call', async () => {
    const agent = await start({ tuning: { maxMessageBytes: 2048 } });
    const { tab, welcome } = await paired(agent);
    const pending = agent.call(READ_TOOL.name);
    const c = await tab.next('call');
    tab.reply(welcome.sessionId, c.id, textResult('z'.repeat(4096)));
    expect(await tab.closed()).toBe(1009);
    const result = await pending;
    expect(result.structuredContent?.code).toBe('VIEWER_NOT_CONNECTED');
    expect(reason(result)).toBe('disconnected');
  });

  it('closes a paired tab that sends a binary frame, failing its pending call', async () => {
    const agent = await start();
    const { tab } = await paired(agent);
    const pending = agent.call(READ_TOOL.name);
    await tab.next('call');
    tab.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    expect(await tab.closed()).toBe(BridgeCloseCode.INVALID_MESSAGE);
    expect((await pending).structuredContent?.code).toBe('VIEWER_NOT_CONNECTED');
  });
});
