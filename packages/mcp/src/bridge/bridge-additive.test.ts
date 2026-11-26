/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * P2 of the MCP overhaul: `--bridge` adds the tab to a headless server
 * instead of replacing it. Headless tools, resources and prompts stay; the
 * tab's tools come and go as `tab_*`; the port falls back when taken; the
 * listener can wait for the first `bridge_status`.
 */

import { createServer, type AddressInfo, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fullScope } from '../auth/scope.js';
import { InMemoryModelRegistry } from '../context.js';
import type { CallToolResult, JsonRpcMessage, ToolDefinition } from '../protocol/index.js';
import { buildDefaultPromptRegistry } from '../prompts/index.js';
import { buildDefaultResourceRegistry } from '../resources/index.js';
import { buildDefaultToolRegistry } from '../tools/index.js';
import { pairTab, READ_TOOL, tabTool, type FakeTab } from '../test/bridge-fake-tab.js';
import { BRIDGE_RESERVED_TOOLS, BRIDGE_STATUS_TOOL, TAB_TOOL_PREFIX } from './bridge-protocol.js';
import { DeliveredSurfaces, MAX_DELIVERED_SURFACES } from './delivered-surfaces.js';
import { fallbackPorts, PORT_FALLBACK_SPAN } from './loopback-server.js';
import { startBridgeServer, type BridgeServerOptions, type RunningBridge } from './run.js';

const running: RunningBridge[] = [];
const tabs: FakeTab[] = [];
const holders: Server[] = [];

afterEach(async () => {
  for (const t of tabs.splice(0)) t.ws.terminate();
  for (const r of running.splice(0)) await r.close();
  for (const h of holders.splice(0)) await new Promise<void>((ok) => h.close(() => ok()));
});

let nextId = 1;

function headless(): NonNullable<BridgeServerOptions['headless']> {
  return {
    registry: new InMemoryModelRegistry(),
    tools: buildDefaultToolRegistry(),
    resources: buildDefaultResourceRegistry(),
    prompts: buildDefaultPromptRegistry(),
    scope: fullScope(),
    config: {},
  };
}

async function start(opts: Partial<BridgeServerOptions> = {}) {
  const r = await startBridgeServer({ version: '0.0.0-test', port: 0, readOnly: false, headless: headless(), ...opts });
  running.push(r);
  const notes: JsonRpcMessage[] = [];
  r.server.attach({ send: (m) => { notes.push(m); } });
  const request = async (method: string, params: unknown = {}) => {
    const res = await r.server.handleMessage({ jsonrpc: '2.0', id: nextId++, method, params });
    if (!res || !('result' in res)) throw new Error(JSON.stringify(res));
    return res.result as Record<string, unknown>;
  };
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  return {
    r,
    notes,
    init,
    request,
    tools: async () => ((await request('tools/list')).tools as ToolDefinition[]).map((t) => t.name),
    call: async (name: string, args: Record<string, unknown> = {}) => (await request('tools/call', { name, arguments: args })) as unknown as CallToolResult,
  };
}

async function holdPort(port = 0): Promise<number> {
  const holder = createServer();
  holders.push(holder);
  await new Promise<void>((ok, fail) => { holder.once('error', fail); holder.listen(port, '127.0.0.1', () => ok()); });
  return (holder.address() as AddressInfo).port;
}

describe('one server: headless and tab', () => {
  it('keeps headless tools, resources and prompts, and adds the tab\'s tools as tab_* while paired', async () => {
    const agent = await start();
    expect(agent.init.capabilities).toMatchObject({ tools: { listChanged: true }, resources: { listChanged: true }, prompts: {} });
    expect(agent.init.instructions).toMatch(/^ifc-lite-mcp exposes/);
    expect(agent.init.instructions).toContain('Tools named tab_* run in that tab');
    const headlessNames = buildDefaultToolRegistry().list().map((t) => t.name);
    const before = await agent.tools();
    expect(before).toEqual([...headlessNames, BRIDGE_STATUS_TOOL]);
    expect(((await agent.request('resources/list')).resources as unknown[]).length).toBeGreaterThan(0);
    expect(((await agent.request('prompts/list')).prompts as unknown[]).length).toBeGreaterThan(0);

    // A tab tool with a headless name keeps both: the headless one by its name, the tab's under the prefix.
    const auditLike = { ...READ_TOOL, name: 'model_audit' };
    const { tab } = await pairTab({ port: agent.r.bridge.port, code: agent.r.bridge.pairingCode(), tools: [auditLike] });
    tabs.push(tab);
    const changed = () => agent.notes.filter((n) => 'method' in n && n.method === 'notifications/tools/list_changed').length;
    await expect.poll(changed).toBe(1);
    expect(await agent.tools()).toEqual([...before, tabTool('model_audit')]);
    // The headless model_audit runs here: with no model loaded it says so instead of reaching the tab.
    const local = await agent.call('model_audit');
    expect(local.isError).toBe(true);
    expect(tab.received.some((f) => f.type === 'call')).toBe(false);

    tab.close();
    await expect.poll(changed).toBe(2);
    expect(await agent.tools()).toEqual(before);
  });

  it('refuses a headless registration that takes a bridge name', async () => {
    const { r } = await start();
    const tool = buildDefaultToolRegistry().list()[0];
    expect(() => r.server.tools.register({ ...tool, name: BRIDGE_STATUS_TOOL })).toThrow(/reserved/);
    expect(() => r.server.tools.register({ ...tool, name: `${TAB_TOOL_PREFIX}anything` })).toThrow(/reserved/);
  });

  it('reserves the tab names whose prefixed form is a bridge tool', () => {
    expect(BRIDGE_RESERVED_TOOLS.has('show_ui')).toBe(true);
    expect(BRIDGE_RESERVED_TOOLS.has('ui_events')).toBe(true);
  });

  it('an unknown non-tab name is unknown, a tab_ name with no tab fails as not connected', async () => {
    const agent = await start();
    const res = await agent.r.server.handleMessage({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
    expect(JSON.stringify(res)).not.toContain('VIEWER_NOT_CONNECTED');
    expect((await agent.call(tabTool('model_info'))).structuredContent?.code).toBe('VIEWER_NOT_CONNECTED');
  });
});

describe('lazy listener and port fallback', () => {
  it('binds nothing until bridge_status, then reports the port the link carries', async () => {
    const agent = await start({ lazy: true });
    expect(agent.r.bridge.port).toBe(0);
    const status = await agent.call(BRIDGE_STATUS_TOOL);
    expect(agent.r.bridge.port).toBeGreaterThan(0);
    const port = status.structuredContent?.port as number;
    expect(port).toBeGreaterThan(0);
    expect(new URL(status.structuredContent?.pairingUrl as string).hash).toContain(`port=${port}`);
  });

  it('falls back past a taken preferred port and names it in the link', async () => {
    const taken = await holdPort();
    const lines: string[] = [];
    const agent = await start({ port: taken, portFallback: true, lazy: true, log: (l) => lines.push(l) });
    const status = await agent.call(BRIDGE_STATUS_TOOL);
    const port = status.structuredContent?.port as number;
    expect(port).not.toBe(taken);
    expect(status.structuredContent?.pairingUrl).toContain(`port=${port}`);
    expect(lines.some((l) => l.includes(`port ${taken} is in use`))).toBe(true);
  });

  it('without fallback a taken port fails bridge_status and a later call can retry', async () => {
    const taken = await holdPort();
    const agent = await start({ port: taken, lazy: true });
    const failed = await agent.call(BRIDGE_STATUS_TOOL);
    expect(failed.isError).toBe(true);
    await new Promise<void>((ok) => holders.pop()!.close(() => ok()));
    const retried = await agent.call(BRIDGE_STATUS_TOOL);
    expect(retried.isError).toBeUndefined();
    expect(retried.structuredContent?.port).toBe(taken);
  });

  it('tries the preferred port, its neighbours, then any', () => {
    expect(fallbackPorts(21517)).toEqual([...Array.from({ length: PORT_FALLBACK_SPAN + 1 }, (_, i) => 21517 + i), 0]);
    expect(fallbackPorts(65535)).toEqual([65535, 0]);
    expect(fallbackPorts(0)).toEqual([0]);
  });
});

describe('DeliveredSurfaces', () => {
  it('a createSurface starts the surface over', () => {
    const ledger = new DeliveredSurfaces();
    ledger.record([{ version: '1.0', createSurface: { surfaceId: 'a', note: 'Old' } }]);
    ledger.record([{ version: '1.0', updateComponents: { surfaceId: 'a', note: 'Added' } }]);
    expect(ledger.refusal({ surfaceId: 'a', name: 'ask', prompt: 'Old' })).toBeNull();
    ledger.record([{ version: '1.0', createSurface: { surfaceId: 'a', note: 'New' } }]);
    expect(ledger.refusal({ surfaceId: 'a', name: 'ask', prompt: 'Old' })).toMatch(/does not contain/);
    expect(ledger.refusal({ surfaceId: 'a', name: 'ask', prompt: 'New' })).toBeNull();
  });

  const created = (surfaceId: string, text: string) => ({ version: '1.0', createSurface: { surfaceId, catalogId: 'c' }, note: text });

  it('forgets a deleted surface and the oldest past the cap', () => {
    const ledger = new DeliveredSurfaces();
    ledger.record([created('a', 'Go')]);
    expect(ledger.refusal({ surfaceId: 'a', name: 'ask', prompt: 'Go' })).toBeNull();
    ledger.record([{ version: '1.0', deleteSurface: { surfaceId: 'a' } }]);
    expect(ledger.refusal({ surfaceId: 'a', name: 'ask', prompt: 'Go' })).toMatch(/did not show/);
    for (let i = 0; i <= MAX_DELIVERED_SURFACES; i++) ledger.record([created(`s${i}`, 'Go')]);
    expect(ledger.refusal({ surfaceId: 's0', name: 'ask', prompt: 'Go' })).toMatch(/did not show/);
    expect(ledger.refusal({ surfaceId: `s${MAX_DELIVERED_SURFACES}`, name: 'ask', prompt: 'Go' })).toBeNull();
  });
});
