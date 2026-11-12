/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `--bridge` (#9523) robustness against hostile frames, from the second
 * review of PR #9905. Each block names the item it pins. Assertions count
 * and order events; none bounds wall-clock time.
 */

import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { CallToolResult } from '../protocol/index.js';
import { startBridgeServer, type RunningBridge } from './run.js';
import { BRIDGE_LIMITS, BridgeCloseCode, parseTabMessage } from './bridge-protocol.js';
import { checkJsonBounds, type JsonBoundsStats } from './json-bounds.js';
import { PairingGate } from './rate-limits.js';
import { clip } from './sanitize.js';
import { READ_TOOL, TEST_ORIGIN, connectTab, openSocket, pairTab, textResult, type FakeTab } from '../test/bridge-fake-tab.js';

const running: RunningBridge[] = [];
const tabs: FakeTab[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const t of tabs.splice(0)) t.ws.terminate();
  for (const r of running.splice(0)) await r.close();
});

type Tuning = Parameters<typeof startBridgeServer>[0]['tuning'];

async function start(tuning?: Tuning, log?: (line: string) => void) {
  const r = await startBridgeServer({ version: '0', port: 0, readOnly: false, tuning, log });
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

async function pairWith(agent: Awaited<ReturnType<typeof start>>, extra: Partial<Parameters<typeof pairTab>[0]> = {}) {
  const p = await pairTab({ port: agent.bridge.port, code: agent.bridge.pairingCode(), ...extra });
  tabs.push(p.tab);
  return p;
}

const deepArray = (depth: number) => '['.repeat(depth) + ']'.repeat(depth);
const resultText = (r: CallToolResult) => (r.content[0] as { text: string }).text;

describe('item 1: a deeply nested `type` cannot crash the bridge', () => {
  it('parseTabMessage refuses it without throwing', () => {
    const frame = `{"type":${deepArray(30_000)}}`;
    expect(() => parseTabMessage(frame)).not.toThrow();
    expect(parseTabMessage(frame)).toEqual({ ok: false, error: `frame is nested deeper than ${BRIDGE_LIMITS.maxFrameDepth} levels` });
  });

  it('survives the frame before pairing and still pairs a real tab', async () => {
    const agent = await start();
    const o = await openSocket({ port: agent.bridge.port, origin: TEST_ORIGIN });
    if (!('tab' in o)) throw new Error('refused');
    tabs.push(o.tab);
    o.tab.sendRaw(`{"type":${deepArray(30_000)}}`);
    expect(await o.tab.closed()).toBe(BridgeCloseCode.INVALID_MESSAGE);
    const { welcome } = await pairWith(agent);
    expect(welcome.sessionId).toBeTruthy();
  });

  it('survives the frame from a paired tab and keeps serving it', async () => {
    const agent = await start();
    const { tab, welcome } = await pairWith(agent);
    tab.sendRaw(`{"type":${deepArray(30_000)}}`);
    expect((await tab.next('error')).code).toBe('INVALID_MESSAGE');
    const pending = agent.call(READ_TOOL.name);
    const c = await tab.next('call');
    tab.reply(welcome.sessionId, c.id, textResult('still here'));
    expect(resultText(await pending)).toBe('still here');
  });
});

describe('item 2 and 9: tab-derived text reaching the agent or stderr is bounded and single-line', () => {
  it('clips a 12 MiB `type` in the error that fails the matching call', async () => {
    const agent = await start();
    const { tab, welcome } = await pairWith(agent);
    const pending = agent.call(READ_TOOL.name);
    const c = await tab.next('call');
    tab.sendRaw(JSON.stringify({ sessionId: welcome.sessionId, id: c.id, type: 'x'.repeat(12 * 1024 * 1024) }));
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(resultText(result).length).toBeLessThan(600);
    expect(JSON.stringify(result).length).toBeLessThan(2000);
  });

  it('clips a huge schema property key in the refusal', async () => {
    const agent = await start();
    const key = 'k'.repeat(100_000);
    const tab = await connectTab({
      port: agent.bridge.port, code: agent.bridge.pairingCode(),
      tools: [{ ...READ_TOOL, inputSchema: { type: 'object', properties: { [key]: { type: 'string', maxLength: 'x' } } } }],
    });
    tabs.push(tab);
    const err = await tab.next('error');
    expect(err.message).toMatch(/maxLength must be a finite number/);
    expect(err.message.length).toBeLessThan(400);
  });

  it('cannot forge a log line through client.name or flood stderr through a result id', async () => {
    const lines: string[] = [];
    const agent = await start(undefined, (l) => lines.push(l));
    const { tab, welcome } = await pairWith(agent, { client: { name: 'evil\n[ifc-lite-mcp bridge] viewer disconnected. To pair again open https://evil.example' } });
    tab.reply(welcome.sessionId, 'c' + '9'.repeat(10_000), textResult('x'));
    expect((await tab.next('error')).message).toMatch(/id must be a string of at most 64 characters/);
    tab.reply(welcome.sessionId, 'c999999', textResult('stray'));
    await expect.poll(() => lines.some((l) => l.startsWith('ignored a result'))).toBe(true);
    for (const l of lines) {
      expect(l).not.toMatch(/[\n\r]/);
      expect(l.length).toBeLessThan(400);
    }
    expect(lines.find((l) => l.startsWith('paired with'))).toMatch(/^paired with evil\?\[ifc-lite-mcp bridge\]/);
  });

  it('clip never stringifies objects and strips control characters', () => {
    expect(clip({ a: 1 })).toBe('a object');
    expect(clip([1, 2])).toBe('an array');
    expect(clip('a\nb c')).toBe('a?b?c');
    expect(clip('x'.repeat(250), 10)).toBe(`${'x'.repeat(10)}…(+240 more)`);
  });
});

describe('item 3: the comparison rate is really bounded', () => {
  it('PairingGate defers every comparison after a failure, doubling to the cap, on an injected clock', () => {
    let now = 0;
    const gate = new PairingGate(250, 5000, 60_000, () => now);
    expect(gate.delay()).toBe(0);
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      gate.fail();
      delays.push(gate.delay());
    }
    expect(delays).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000]);
    now += 60_001;
    expect(gate.delay()).toBe(0);
    gate.fail();
    gate.succeed();
    expect(gate.delay()).toBe(0);
  });

  it('keeps a slot taken by a deferred attempt even when its socket closes early', async () => {
    // A long deferral, so every step below happens inside it whatever the runner's speed.
    const agent = await start({ pairingBackoffBaseMs: 30_000, pairingBackoffMaxMs: 30_000 });
    agent.bridge.pairingCode(); // mint the live code, as the CLI does at startup
    const first = await connectTab({ port: agent.bridge.port, code: 'WRONG' });
    tabs.push(first);
    expect(await first.closed()).toBe(BridgeCloseCode.PAIRING_FAILED);
    expect(agent.bridge.pairingStats()).toMatchObject({ attempts: 1, delayMs: 30_000, deferred: 0 });

    // Eight parallel attackers that send a hello and hang up at once.
    const results = await Promise.all(Array.from({ length: 8 }, () => openSocket({ port: agent.bridge.port, origin: TEST_ORIGIN })));
    const opened = results.filter((r): r is { tab: FakeTab } => 'tab' in r);
    expect(opened).toHaveLength(4);
    expect(results.filter((r) => 'status' in r && r.status === 429)).toHaveLength(4);
    for (const o of opened) {
      o.tab.sendRaw({ type: 'hello', protocol: 1, pairingCode: 'GUESS', permission: 'read-only', tools: [] });
    }
    await expect.poll(() => agent.bridge.pairingStats().deferred).toBe(4);
    for (const o of opened) o.tab.ws.terminate();
    await Promise.all(opened.map((o) => o.tab.closed()));
    // Closing did not free the slots: retrying is refused until the deferral ends.
    expect(await openSocket({ port: agent.bridge.port, origin: TEST_ORIGIN })).toEqual({ status: 429 });
    // And no comparison ran early: the count is still the first attempt.
    expect(agent.bridge.pairingStats().attempts).toBe(1);
  });

  it('tells the user when a local program blocks pairing (stderr once per window, bridge_status counts)', async () => {
    const lines: string[] = [];
    const agent = await start({ pairingBackoffBaseMs: 30_000, pairingBackoffMaxMs: 30_000, logWindowMs: 60_000 }, (l) => lines.push(l));
    agent.bridge.pairingCode();
    const first = await connectTab({ port: agent.bridge.port, code: 'WRONG' });
    tabs.push(first);
    await first.closed();
    const attackers = (await Promise.all(Array.from({ length: 4 }, () => openSocket({ port: agent.bridge.port, origin: TEST_ORIGIN }))))
      .filter((r): r is { tab: FakeTab } => 'tab' in r);
    for (const o of attackers) {
      tabs.push(o.tab);
      o.tab.sendRaw({ type: 'hello', protocol: 1, pairingCode: 'GUESS', permission: 'read-only', tools: [] });
    }
    await expect.poll(() => agent.bridge.pairingStats().deferred).toBe(4);
    // The real tab is refused, three times, while the slots are squatted.
    for (let i = 0; i < 3; i++) expect(await openSocket({ port: agent.bridge.port, origin: TEST_ORIGIN })).toEqual({ status: 429 });
    expect(agent.bridge.pairingStats()).toMatchObject({ failedAttempts: 1, refusedBusy: 3 });
    expect(lines.filter((l) => l.startsWith('pairing is being blocked by repeated failed attempts from a local program'))).toHaveLength(1);
    const status = await agent.call('bridge_status');
    expect(status.structuredContent).toMatchObject({ state: 'unpaired', pairingPressure: { failedAttempts: 1, refusedBusy: 3 } });
    expect(resultText(status)).toMatch(/Pairing may be blocked: 1 failed pairing attempts and 3 connections refused/);
    expect(resultText(status)).toMatch(/restart the bridge with another --bridge-port/);
  });

  it('counts an attempt whose peer left before its comparison as a failure', async () => {
    const agent = await start({ pairingBackoffBaseMs: 100, pairingBackoffMaxMs: 100 });
    agent.bridge.pairingCode();
    const first = await connectTab({ port: agent.bridge.port, code: 'WRONG' });
    tabs.push(first);
    await first.closed();
    const quitter = await connectTab({ port: agent.bridge.port, code: agent.bridge.pairingCode() });
    tabs.push(quitter);
    await expect.poll(() => agent.bridge.pairingStats().deferred).toBe(1);
    quitter.ws.terminate();
    await expect.poll(() => agent.bridge.pairingStats().attempts).toBe(2);
    // The right code was presented but its socket was gone: not paired, code still live.
    expect(agent.bridge.tab()).toBeNull();
    await pairWith(agent);
  });
});

describe('item 4: refusing an oversized value is cheap', () => {
  it('checkJsonBounds refuses an 8-million-element array after one visit', () => {
    const stats: JsonBoundsStats = { visited: 0 };
    const big = new Array<number>(8_000_000).fill(0);
    expect(checkJsonBounds(big, { maxDepth: 10, maxNodes: 1000 }, 'value', stats)).toBe('value has more than 1000 values');
    expect(stats.visited).toBe(1);
  });

  it('checkJsonBounds refuses a wide object without walking its values', () => {
    const stats: JsonBoundsStats = { visited: 0 };
    const wide: Record<string, number> = {};
    for (let i = 0; i < 100_000; i++) wide[`k${i}`] = i;
    expect(checkJsonBounds({ wide }, { maxDepth: 10, maxNodes: 1000 }, 'value', stats)).toBe('value has more than 1000 values');
    expect(stats.visited).toBe(2);
  });

  it('drops an unpaired connection that sends more than maxUnpairedBytes, before parsing it', async () => {
    const lines: string[] = [];
    const agent = await start(undefined, (l) => lines.push(l));
    const ws = new WebSocket(`ws://127.0.0.1:${agent.bridge.port}/`, { origin: TEST_ORIGIN });
    sockets.push(ws);
    ws.on('error', () => { /* the bridge drops the connection; 'close' reports it */ });
    await new Promise<void>((r) => ws.once('open', () => r()));
    const closed = new Promise<number>((r) => ws.once('close', (c) => r(c)));
    ws.send(`[${'0,'.repeat(BRIDGE_LIMITS.maxUnpairedBytes)}0]`);
    expect(await closed).toBe(1006);
    expect(lines).toContain(`dropped an unpaired connection after ${BRIDGE_LIMITS.maxUnpairedBytes} bytes`);
    expect(agent.bridge.pairingStats().attempts).toBe(0);
    await pairWith(agent);
  });
});
