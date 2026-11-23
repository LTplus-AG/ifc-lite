/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewer UI events: the `ui-event` frame from a paired tab, the
 * `viewer_ui_events` tool that drains them, and the `--channel` push into a
 * Claude Code session.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { CallToolResult, JsonRpcMessage, ToolDefinition } from '../protocol/index.js';
import { startBridgeServer, type RunningBridge } from './run.js';
import { BRIDGE_FEATURE_UI_EVENTS, parseTabMessage, UI_EVENT_LIMITS } from './bridge-protocol.js';
import { UiEventInbox } from './ui-events.js';
import { pairTab, type FakeTab } from '../test/bridge-fake-tab.js';

const running: RunningBridge[] = [];
const tabs: FakeTab[] = [];

afterEach(async () => {
  for (const t of tabs.splice(0)) t.ws.terminate();
  for (const r of running.splice(0)) await r.close();
});

let nextId = 1;

async function startAgent(channel = false) {
  const r = await startBridgeServer({ version: '0.0.0-test', port: 0, readOnly: true, channel });
  running.push(r);
  const notes: JsonRpcMessage[] = [];
  r.server.attach({ send: (m) => { notes.push(m); } });
  const init = await r.server.handleMessage({
    jsonrpc: '2.0', id: nextId++, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-agent', version: '1' } },
  });
  const request = async (method: string, params: unknown) => {
    const res = await r.server.handleMessage({ jsonrpc: '2.0', id: nextId++, method, params });
    if (!res || !('result' in res)) throw new Error(JSON.stringify(res));
    return res.result;
  };
  return {
    r,
    notes,
    capabilities: (init && 'result' in init ? (init.result as { capabilities: Record<string, unknown> }).capabilities : {}),
    listTools: async () => ((await request('tools/list', {})) as { tools: ToolDefinition[] }).tools.map((t) => t.name),
    call: async (name: string, args: Record<string, unknown> = {}) => (await request('tools/call', { name, arguments: args })) as CallToolResult,
  };
}

async function pair(agent: Awaited<ReturnType<typeof startAgent>>, a2uiSurface = true) {
  const paired = await pairTab({ port: agent.r.bridge.port, code: agent.r.bridge.pairingCode(), ...(a2uiSurface ? { a2uiSurface: true as const } : {}) });
  tabs.push(paired.tab);
  const send = (event: Record<string, unknown>) => paired.tab.sendRaw({ type: 'ui-event', sessionId: paired.welcome.sessionId, event });
  return { ...paired, send };
}

describe('ui-event frame', () => {
  it('parses a bounded event and refuses oversized or malformed ones', () => {
    const frame = (event: unknown) => JSON.stringify({ type: 'ui-event', sessionId: 's', event });
    expect(parseTabMessage(frame({ surfaceId: 'walls', name: 'ask', prompt: 'Which are external?', context: { refs: ['m:1'] } }))).toEqual({
      ok: true, value: { type: 'ui-event', sessionId: 's', event: { surfaceId: 'walls', name: 'ask', prompt: 'Which are external?', context: { refs: ['m:1'] } } },
    });
    expect(parseTabMessage(frame({ surfaceId: '', name: 'ask' })).ok).toBe(false);
    expect(parseTabMessage(frame({ surfaceId: 'x', name: 'ask', prompt: 'p'.repeat(UI_EVENT_LIMITS.maxPromptLength + 1) })).ok).toBe(false);
    expect(parseTabMessage(frame({ surfaceId: 'x', name: 'ask', context: { blob: 'x'.repeat(UI_EVENT_LIMITS.maxContextBytes) } })).ok).toBe(false);
    expect(parseTabMessage(frame({ surfaceId: 'x', name: 'ask', context: [] })).ok).toBe(false);
  });
});

describe('UiEventInbox', () => {
  it('rate-limits, caps the queue and wakes a waiting reader', async () => {
    let t = 0;
    const inbox = new UiEventInbox(() => t);
    for (let i = 0; i < UI_EVENT_LIMITS.maxPerSecond; i++) expect(inbox.push({ surfaceId: 's', name: 'ask' })).toBe(true);
    expect(inbox.push({ surfaceId: 's', name: 'ask' })).toBe(false);
    t = 5000;
    for (let i = 0; i < UI_EVENT_LIMITS.maxQueued; i++) { t += 200; inbox.push({ surfaceId: 's', name: 'ask' }); }
    expect(inbox.size).toBe(UI_EVENT_LIMITS.maxQueued);
    expect((await inbox.take(0)).dropped).toBe(1 + UI_EVENT_LIMITS.maxPerSecond);
    const waiting = inbox.take(10_000);
    t += 1000;
    inbox.push({ surfaceId: 's', name: 'ask', prompt: 'next' });
    // The drop count is a delta: it was reported once and starts again from zero.
    await expect(waiting).resolves.toMatchObject({ events: [{ prompt: 'next' }], dropped: 0 });
  });

  it('stops waiting when the call is cancelled', async () => {
    const inbox = new UiEventInbox();
    const abort = new AbortController();
    const waiting = inbox.take(60_000, abort.signal);
    abort.abort();
    await expect(waiting).resolves.toEqual({ events: [], dropped: 0 });
  });
});

describe('viewer_ui_events', () => {
  it('advertises the feature, lists the tool for surface tabs and drains clicks', async () => {
    const agent = await startAgent();
    const { welcome, send } = await pair(agent);
    expect(welcome.features).toContain(BRIDGE_FEATURE_UI_EVENTS);
    expect(await agent.listTools()).toEqual(expect.arrayContaining(['viewer_show_ui', 'viewer_ui_events']));
    const waiting = agent.call('viewer_ui_events', { wait_seconds: 5 });
    send({ surfaceId: 'walls', name: 'ask', prompt: 'Isolate the external walls', context: { refs: ['m:12'] } });
    const result = await waiting;
    expect(result.structuredContent?.events).toMatchObject([{ id: 'e1', surfaceId: 'walls', name: 'ask', prompt: 'Isolate the external walls', context: { refs: ['m:12'] } }]);
    expect((result.content[0] as { text: string }).text).toContain('[e1] ask on walls: Isolate the external walls');
    expect((await agent.call('viewer_ui_events')).structuredContent?.events).toEqual([]);
    expect(agent.notes.some((n) => 'method' in n && n.method === 'notifications/claude/channel')).toBe(false);
  });

  it('ignores events from a tab that did not opt in to surfaces', async () => {
    const agent = await startAgent();
    const { send } = await pair(agent, false);
    expect(await agent.listTools()).not.toContain('viewer_ui_events');
    send({ surfaceId: 'walls', name: 'ask', prompt: 'hi' });
    await new Promise((r) => setTimeout(r, 50));
    expect(agent.r.bridge.uiEvents.size).toBe(0);
  });

  it('does not hand a new tab the previous tab\'s unread events', async () => {
    const agent = await startAgent();
    const first = await pair(agent);
    first.send({ surfaceId: 'walls', name: 'ask', prompt: 'old' });
    await expect.poll(() => agent.r.bridge.uiEvents.size).toBe(1);
    const second = await pairTab({ port: agent.r.bridge.port, code: agent.r.bridge.rotatePairingCode(), a2uiSurface: true });
    tabs.push(second.tab);
    expect(agent.r.bridge.uiEvents.size).toBe(0);
    second.tab.sendRaw({ type: 'ui-event', sessionId: second.welcome.sessionId, event: { surfaceId: 'walls', name: 'ask', prompt: 'new' } });
    await expect.poll(() => agent.r.bridge.uiEvents.size).toBe(1);
    expect((await agent.call('viewer_ui_events')).structuredContent?.events).toMatchObject([{ prompt: 'new' }]);
  });
});

describe('--channel', () => {
  it('declares claude/channel and pushes each event as a channel notification', async () => {
    const agent = await startAgent(true);
    expect(agent.capabilities.experimental).toEqual({ 'claude/channel': {} });
    const { send } = await pair(agent);
    send({ surfaceId: 'walls', name: 'ask', prompt: 'Colour by storey' });
    const channel = () => agent.notes.find((n) => 'method' in n && n.method === 'notifications/claude/channel');
    await expect.poll(channel).toBeTruthy();
    expect(channel()).toMatchObject({ params: { content: 'Colour by storey', meta: { event_id: 'e1', event: 'ask', surface_id: 'walls' } } });
    send({ surfaceId: 'rooms', name: 'pickRoom', prompt: 'Show room 1.02', context: { ref: 'm:9' } });
    await expect.poll(() => agent.notes.filter((n) => 'method' in n && n.method === 'notifications/claude/channel').length).toBe(2);
    expect(agent.notes.filter((n) => 'method' in n && n.method === 'notifications/claude/channel')[1]).toMatchObject({
      params: { content: 'The user triggered "pickRoom" on surface rooms (Show room 1.02). Context: {"ref":"m:9"}', meta: { event: 'pickRoom' } },
    });
    // An ask keeps the user's choices from a form on the surface.
    send({ surfaceId: 'walls', name: 'ask', prompt: 'Check the selected types', context: { prompt: 'Check the selected types', types: ['IfcWall'] } });
    await expect.poll(() => agent.notes.filter((n) => 'method' in n && n.method === 'notifications/claude/channel').length).toBe(3);
    expect(agent.notes.filter((n) => 'method' in n && n.method === 'notifications/claude/channel')[2]).toMatchObject({
      params: { content: 'Check the selected types Context: {"types":["IfcWall"]}' },
    });
    // Still queued, so a client that ignores channels loses nothing.
    expect(agent.r.bridge.uiEvents.size).toBe(3);
  });

  it('is off by default', async () => {
    const agent = await startAgent();
    expect(agent.capabilities.experimental).toBeUndefined();
  });
});
