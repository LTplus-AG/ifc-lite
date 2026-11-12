/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite-mcp --bridge` (#9523) against a fake tab (a `ws` client). The
 * numbered blocks are the acceptance cases from the issue's triage review:
 * read-only pairing rejects mutations, closing or replacing the tab fails
 * pending calls, a used pairing code cannot reconnect, and replies from an
 * earlier tab or session cannot answer a new request. Every bridge binds port
 * 0, so the tests never depend on a fixed port.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { CallToolResult, JsonRpcMessage, JsonRpcResponse, ToolDefinition } from '../protocol/index.js';
import { startBridgeServer, type RunningBridge } from './run.js';
import { BridgeCloseCode, BRIDGE_STATUS_TOOL, parsePairingFragment } from './bridge-protocol.js';
import {
  MUTATING_TOOL,
  READ_TOOL,
  connectTab,
  openSocket,
  pairTab,
  textResult,
  type FakeTab,
} from '../test/bridge-fake-tab.js';

const running: RunningBridge[] = [];
const tabs: FakeTab[] = [];

afterEach(async () => {
  for (const t of tabs.splice(0)) t.ws.terminate();
  for (const r of running.splice(0)) await r.close();
});

interface Agent {
  bridge: RunningBridge['bridge'];
  notifications: JsonRpcMessage[];
  listTools(): Promise<string[]>;
  call(name: string, args?: Record<string, unknown>, id?: number): Promise<CallToolResult>;
  cancel(id: number): Promise<void>;
}

let nextId = 100;

/** A bridge on port 0 plus an initialised MCP client driving its server in-process. */
async function startAgent(opts: { readOnly?: boolean; tuning?: Parameters<typeof startBridgeServer>[0]['tuning'] } = {}): Promise<Agent> {
  const r = await startBridgeServer({ version: '0.0.0-test', port: 0, readOnly: opts.readOnly ?? false, tuning: opts.tuning });
  running.push(r);
  const notifications: JsonRpcMessage[] = [];
  r.server.attach({ send: (m) => { notifications.push(m); } });
  await r.server.handleMessage({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-agent', version: '1' } },
  });
  const request = async (method: string, params: unknown, id = nextId++): Promise<JsonRpcResponse> => {
    const res = await r.server.handleMessage({ jsonrpc: '2.0', id, method, params });
    if (!res) throw new Error(`no response to ${method}`);
    return res;
  };
  return {
    bridge: r.bridge,
    notifications,
    async listTools() {
      const res = await request('tools/list', {});
      if (!('result' in res)) throw new Error(JSON.stringify(res));
      return (res.result as { tools: ToolDefinition[] }).tools.map((t) => t.name);
    },
    async call(name, args = {}, id) {
      const res = await request('tools/call', { name, arguments: args }, id);
      if (!('result' in res)) throw new Error(JSON.stringify(res));
      return res.result as CallToolResult;
    },
    async cancel(id) {
      await r.server.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
    },
  };
}

function code(result: CallToolResult): unknown {
  return result.structuredContent?.code;
}

function reason(result: CallToolResult): unknown {
  return (result.structuredContent?.details as { reason?: unknown } | undefined)?.reason;
}

async function pair(agent: Agent, extra: Partial<Parameters<typeof pairTab>[0]> = {}) {
  const paired = await pairTab({ port: agent.bridge.port, code: agent.bridge.pairingCode(), ...extra });
  tabs.push(paired.tab);
  return paired;
}

describe('1. read-only pairing', () => {
  it('neither lists nor forwards a mutating tool', async () => {
    const agent = await startAgent();
    const { tab, welcome } = await pair(agent, { permission: 'read-only' });
    expect(welcome.permission).toBe('read-only');

    expect(await agent.listTools()).toEqual([BRIDGE_STATUS_TOOL, READ_TOOL.name]);

    const refused = await agent.call(MUTATING_TOOL.name, { id: 1, value: 'x' });
    expect(refused.isError).toBe(true);
    expect(code(refused)).toBe('READ_ONLY');

    // The next call the tab sees is the read call: the mutating one never left the bridge.
    const pending = agent.call(READ_TOOL.name, { type: 'IfcWall' });
    const call = await tab.next('call');
    expect(call.name).toBe(READ_TOOL.name);
    tab.reply(welcome.sessionId, call.id, textResult('3 walls'));
    expect((await pending).content).toEqual([{ type: 'text', text: '3 walls' }]);
    expect(tab.calls().map((c) => c.name)).toEqual([READ_TOOL.name]);
  });

  it('treats --read-only as a ceiling the tab cannot raise', async () => {
    const agent = await startAgent({ readOnly: true });
    const { tab, welcome } = await pair(agent, { permission: 'read-write' });
    expect(welcome.permission).toBe('read-only');
    expect(welcome.readOnlyCeiling).toBe(true);
    expect(await agent.listTools()).not.toContain(MUTATING_TOOL.name);

    tab.sendRaw({ type: 'update', sessionId: welcome.sessionId, permission: 'read-write' });
    await new Promise((r) => setTimeout(r, 50));
    expect(await agent.listTools()).not.toContain(MUTATING_TOOL.name);
    const refused = await agent.call(MUTATING_TOOL.name, { id: 1, value: 'x' });
    expect(code(refused)).toBe('READ_ONLY');
    expect(tab.calls()).toEqual([]);
  });

  it('lists and forwards mutating tools once the tab allows changes, and says so', async () => {
    const agent = await startAgent();
    const { tab, welcome } = await pair(agent, { permission: 'read-only' });
    const before = agent.notifications.length;
    tab.sendRaw({ type: 'update', sessionId: welcome.sessionId, permission: 'read-write' });
    await expect.poll(() => agent.notifications.length).toBeGreaterThan(before);
    expect(agent.notifications.at(-1)).toMatchObject({ method: 'notifications/tools/list_changed' });
    expect(await agent.listTools()).toContain(MUTATING_TOOL.name);

    const pending = agent.call(MUTATING_TOOL.name, { id: 7, value: 'EI30' });
    const call = await tab.next('call');
    expect(call).toMatchObject({ name: MUTATING_TOOL.name, arguments: { id: 7, value: 'EI30' } });
    tab.reply(welcome.sessionId, call.id, textResult('ok'));
    expect((await pending).isError).toBeUndefined();
  });
});

describe('MCP tool annotations from the tab\'s readOnly flag', () => {
  it('lists readOnlyHint/destructiveHint and the tab\'s title, and marks bridge_status read-only', async () => {
    const agent = await startAgent();
    await pair(agent, { permission: 'read-write' });
    const res = await running.at(-1)!.server.handleMessage({ jsonrpc: '2.0', id: 9000, method: 'tools/list', params: {} });
    const tools = ((res as { result: { tools: ToolDefinition[] } }).result.tools);
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get(BRIDGE_STATUS_TOOL)?.annotations).toEqual({ readOnlyHint: true });
    expect(byName.get(READ_TOOL.name)).toMatchObject({ title: 'Query entities', annotations: { readOnlyHint: true } });
    expect(byName.get(MUTATING_TOOL.name)?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get(MUTATING_TOOL.name)).not.toHaveProperty('title');
  });
});

describe('2. closing or replacing the tab fails pending calls', () => {
  it('fails a pending call as soon as the tab closes', async () => {
    const agent = await startAgent();
    const { tab } = await pair(agent);
    const pending = agent.call(READ_TOOL.name, {});
    await tab.next('call');
    const started = Date.now();
    tab.close();
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.isError).toBe(true);
    expect(code(result)).toBe('VIEWER_NOT_CONNECTED');
    expect(reason(result)).toBe('disconnected');
    expect(await agent.listTools()).toEqual([BRIDGE_STATUS_TOOL]);
  });

  it('fails the old tab\'s pending call when a new tab replaces it, and closes the old socket', async () => {
    const agent = await startAgent();
    const { tab: oldTab } = await pair(agent);
    const pending = agent.call(READ_TOOL.name, {});
    await oldTab.next('call');

    // A replacement needs a code the user asked for; none is live while paired.
    const status = await agent.call(BRIDGE_STATUS_TOOL, { pair_new_tab: true });
    const fresh = status.structuredContent?.pairingCode as string;
    const { tab: newTab, welcome } = await pair(agent, { code: fresh });

    const result = await pending;
    expect(code(result)).toBe('VIEWER_NOT_CONNECTED');
    expect(reason(result)).toBe('replaced');
    expect(await oldTab.next('error')).toMatchObject({ code: 'REPLACED' });
    expect(await oldTab.closed()).toBe(BridgeCloseCode.REPLACED);

    const next = agent.call(READ_TOOL.name, {});
    const call = await newTab.next('call');
    newTab.reply(welcome.sessionId, call.id, textResult('from the new tab'));
    expect((await next).content).toEqual([{ type: 'text', text: 'from the new tab' }]);
  });

  it('times out a call the tab never answers and tells the tab to stop', async () => {
    const agent = await startAgent({ tuning: { callTimeoutMs: 100 } });
    const { tab } = await pair(agent);
    const result = await agent.call(READ_TOOL.name, {});
    expect(code(result)).toBe('TIMEOUT');
    const call = tab.calls()[0];
    expect(await tab.next('cancel')).toMatchObject({ id: call.id, reason: 'timeout' });
  });

  it('forwards an MCP cancellation to the tab', async () => {
    const agent = await startAgent();
    const { tab } = await pair(agent);
    const pending = agent.call(READ_TOOL.name, {}, 4242);
    const call = await tab.next('call');
    await agent.cancel(4242);
    expect(code(await pending)).toBe('CANCELLED');
    expect(await tab.next('cancel')).toMatchObject({ id: call.id, reason: 'cancelled' });
  });
});

describe('3. pairing codes', () => {
  it('refuses a code that was already used, even after the tab is gone', async () => {
    const agent = await startAgent();
    const used = agent.bridge.pairingCode();
    const { tab } = await pair(agent, { code: used });
    tab.close();
    await tab.closed();
    await expect.poll(() => agent.bridge.tab()).toBeNull();

    const again = await connectTab({ port: agent.bridge.port, code: used });
    tabs.push(again);
    expect(await again.next('error')).toMatchObject({ code: 'PAIRING_FAILED' });
    expect(await again.closed()).toBe(BridgeCloseCode.PAIRING_FAILED);
    expect(agent.bridge.pairingCode()).not.toBe(used);
  });

  it('refuses every code while a tab is paired and none was asked for', async () => {
    const agent = await startAgent();
    const used = agent.bridge.pairingCode();
    await pair(agent, { code: used });
    const intruder = await connectTab({ port: agent.bridge.port, code: used });
    tabs.push(intruder);
    expect(await intruder.closed()).toBe(BridgeCloseCode.PAIRING_FAILED);
    expect(agent.bridge.tab()).not.toBeNull();
  });

  it('refuses a wrong code and accepts the right one with any case and separators', async () => {
    const agent = await startAgent();
    const wrong = await connectTab({ port: agent.bridge.port, code: 'AAAAA-AAAAA-AAAAA-AAAAA' });
    tabs.push(wrong);
    expect(await wrong.closed()).toBe(BridgeCloseCode.PAIRING_FAILED);
    const sloppy = agent.bridge.pairingCode().toLowerCase().replace(/-/g, ' ');
    const { welcome } = await pair(agent, { code: sloppy });
    expect(welcome.sessionId).toMatch(/[0-9a-f-]{36}/);
  });

  it('slows wrong codes with a growing delay but never retires the user\'s code (rotation denial)', async () => {
    const agent = await startAgent({ tuning: { pairingBackoffBaseMs: 80, pairingBackoffMaxMs: 400 } });
    const original = agent.bridge.pairingCode();
    const latencies: number[] = [];
    for (let i = 0; i < 4; i++) {
      const started = Date.now();
      const t = await connectTab({ port: agent.bridge.port, code: `WRONG-${i}` });
      tabs.push(t);
      expect(await t.closed(3000)).toBe(BridgeCloseCode.PAIRING_FAILED);
      latencies.push(Date.now() - started);
    }
    // 80, 160, 320, 400 (capped): each wrong code waits at least its delay.
    expect(latencies[0]).toBeGreaterThanOrEqual(75);
    expect(latencies[2]).toBeGreaterThanOrEqual(315);
    expect(latencies[3]).toBeGreaterThanOrEqual(395);
    expect(agent.bridge.pairingCode()).toBe(original);
    const started = Date.now();
    await pair(agent, { code: original });
    expect(Date.now() - started).toBeLessThan(300);
  });

  it('does not feed the back-off with attempts made while a tab is paired', async () => {
    const agent = await startAgent({ tuning: { pairingBackoffBaseMs: 100, pairingBackoffMaxMs: 5000 } });
    const { tab } = await pair(agent);
    for (let i = 0; i < 6; i++) {
      const t = await connectTab({ port: agent.bridge.port, code: 'ANY' });
      tabs.push(t);
      await t.closed();
    }
    tab.close();
    await expect.poll(() => agent.bridge.tab()).toBeNull();
    const started = Date.now();
    const wrong = await connectTab({ port: agent.bridge.port, code: 'WRONG' });
    tabs.push(wrong);
    await wrong.closed(3000);
    // The first counted failure waits the base delay, not 2^6 times it.
    expect(Date.now() - started).toBeLessThan(800);
  });

  it('rejects a protocol version mismatch without using up the code', async () => {
    const agent = await startAgent();
    const live = agent.bridge.pairingCode();
    const old = await connectTab({ port: agent.bridge.port, code: live, protocol: 999 });
    tabs.push(old);
    expect(await old.next('error')).toMatchObject({ code: 'PROTOCOL_VERSION_MISMATCH' });
    expect(await old.closed()).toBe(BridgeCloseCode.PROTOCOL_VERSION_MISMATCH);
    await pair(agent, { code: live });
  });

  it('closes a socket that never says hello', async () => {
    const agent = await startAgent({ tuning: { handshakeTimeoutMs: 100 } });
    const opened = await openSocket({ port: agent.bridge.port, origin: 'https://ifclite.com' });
    if (!('tab' in opened)) throw new Error('refused');
    tabs.push(opened.tab);
    expect(await opened.tab.closed()).toBe(BridgeCloseCode.HANDSHAKE_TIMEOUT);
  });
});

describe('4. replies from an earlier tab or session cannot answer a new request', () => {
  it('ignores a stale session id, an unknown id, an earlier call id and a duplicate', async () => {
    const agent = await startAgent();
    const { tab: first, welcome: firstWelcome } = await pair(agent);
    const abandoned = agent.call(READ_TOOL.name, {});
    const oldCall = await first.next('call');
    const status = await agent.call(BRIDGE_STATUS_TOOL, { pair_new_tab: true });
    const { tab: second, welcome } = await pair(agent, { code: status.structuredContent?.pairingCode as string });
    expect(reason(await abandoned)).toBe('replaced');
    expect(welcome.sessionId).not.toBe(firstWelcome.sessionId);

    const current = agent.call(READ_TOOL.name, {});
    const call = await second.next('call');
    expect(call.id).not.toBe(oldCall.id);

    // Each of these would answer `current` if the bridge matched loosely.
    second.reply(firstWelcome.sessionId, call.id, textResult('stale session'));
    second.reply(welcome.sessionId, oldCall.id, textResult('earlier call'));
    second.reply(welcome.sessionId, 'c999999', textResult('unknown id'));
    second.reply(welcome.sessionId, call.id, textResult('the real answer'));
    second.reply(welcome.sessionId, call.id, textResult('duplicate'));
    expect((await current).content).toEqual([{ type: 'text', text: 'the real answer' }]);

    // The duplicate must not be waiting to answer the next call either.
    const following = agent.call(READ_TOOL.name, {});
    const nextCall = await second.next('call');
    second.reply(welcome.sessionId, nextCall.id, textResult('second answer'));
    expect((await following).content).toEqual([{ type: 'text', text: 'second answer' }]);
  });

  it('fails a call at once when the tab answers it with a malformed result', async () => {
    const agent = await startAgent();
    const { tab, welcome } = await pair(agent);
    const pending = agent.call(READ_TOOL.name, {});
    const call = await tab.next('call');
    tab.sendRaw({ type: 'result', sessionId: welcome.sessionId, id: call.id, result: { content: 'not an array' } });
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(reason(result)).toBe('malformed-result');
  });
});

describe('5. upgrade guards', () => {
  it('refuses a disallowed or missing Origin before the socket opens', async () => {
    const agent = await startAgent();
    const port = agent.bridge.port;
    expect(await openSocket({ port, origin: 'https://evil.example' })).toEqual({ status: 403 });
    expect(await openSocket({ port, origin: 'http://ifclite.com' })).toEqual({ status: 403 });
    expect(await openSocket({ port })).toEqual({ status: 403 });
  });

  it('refuses a Host that is not loopback on the bridge port (DNS rebinding)', async () => {
    const agent = await startAgent();
    const port = agent.bridge.port;
    const origin = 'https://ifclite.com';
    expect(await openSocket({ port, origin, host: `evil.example:${port}` })).toEqual({ status: 403 });
    expect(await openSocket({ port, origin, host: `127.0.0.1:${port + 1}` })).toEqual({ status: 403 });
    expect(await openSocket({ port, origin, host: '127.0.0.1' })).toEqual({ status: 403 });
    const ok = await openSocket({ port, origin, host: `localhost:${port}` });
    expect('tab' in ok).toBe(true);
    if ('tab' in ok) tabs.push(ok.tab);
  });

  it('allows the --bridge-viewer-url origin and --allow-origin extras', async () => {
    const r = await startBridgeServer({
      version: '0', port: 0, readOnly: false,
      viewerUrl: 'http://localhost:5173/viewer', extraOrigins: ['https://staging.example.test'],
    });
    running.push(r);
    const port = r.bridge.port;
    for (const origin of ['http://localhost:5173', 'https://staging.example.test']) {
      const ok = await openSocket({ port, origin });
      expect('tab' in ok).toBe(true);
      if ('tab' in ok) tabs.push(ok.tab);
    }
    expect(await openSocket({ port, origin: 'https://ifclite.com' })).toEqual({ status: 403 });
  });
});

describe('6. no connected viewer', () => {
  it('lists only bridge_status and fails any other call at once', async () => {
    const agent = await startAgent();
    expect(await agent.listTools()).toEqual([BRIDGE_STATUS_TOOL]);
    const started = Date.now();
    const result = await agent.call('query_entities', { type: 'IfcWall' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.isError).toBe(true);
    expect(code(result)).toBe('VIEWER_NOT_CONNECTED');
    expect(reason(result)).toBe('no-viewer');
  });

  it('bridge_status returns the code and a link with port and code in the fragment only', async () => {
    const agent = await startAgent();
    const status = await agent.call(BRIDGE_STATUS_TOOL, {});
    const sc = status.structuredContent as { state: string; pairingCode: string; pairingUrl: string; port: number };
    expect(sc.state).toBe('unpaired');
    expect(sc.port).toBe(agent.bridge.port);
    const url = new URL(sc.pairingUrl);
    expect(url.origin).toBe('https://ifclite.com');
    expect(url.search).toBe('');
    expect(parsePairingFragment(url.hash)).toEqual({ protocol: 1, port: agent.bridge.port, code: sc.pairingCode });
    expect((status.content[0] as { text: string }).text).toContain(sc.pairingUrl);

    // The code it hands out is the one that pairs.
    await pair(agent, { code: sc.pairingCode });
    const paired = await agent.call(BRIDGE_STATUS_TOOL, {});
    expect(paired.structuredContent).toMatchObject({ state: 'paired', viewer: { permission: 'read-only', toolCount: 2 } });
    expect(paired.structuredContent?.pairingCode).toBeUndefined();
  });

  it('notifies tools/list_changed on connect and disconnect', async () => {
    const agent = await startAgent();
    const changed = () => agent.notifications.filter((n) => 'method' in n && n.method === 'notifications/tools/list_changed').length;
    const { tab } = await pair(agent);
    expect(changed()).toBe(1);
    tab.close();
    await expect.poll(changed).toBe(2);
  });
});
