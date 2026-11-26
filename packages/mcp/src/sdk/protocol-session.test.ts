/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lifecycle gaps #11542 left open, closed by serving the wire through the
 * SDK: params the spec schemas refuse answer -32602 (not -32603), not
 * initialized and resource-not-found no longer share -32002, a cancelled
 * request gets no response, and detach ends the connection.
 */

import { describe, expect, it } from 'vitest';
import {
  MCPServer,
  PROTOCOL_VERSION,
  ToolRegistry,
  buildDefaultPromptRegistry,
  buildDefaultResourceRegistry,
  type JsonRpcMessage,
  type Tool,
} from '../index.js';

type Reply = { result?: Record<string, unknown>; error?: { code: number; data?: unknown } } | null;

function build() {
  const tools = new ToolRegistry();
  let release: () => void = () => undefined;
  const abortNames: string[] = [];
  tools.register({
    name: 'bad_result', description: 'Returns structuredContent the spec refuses.', scope: 'read', inputSchema: { type: 'object' },
    handler: () => ({ content: [], structuredContent: [1, 2] as unknown as Record<string, unknown> }),
  } satisfies Tool);
  tools.register({
    name: 'wait', description: 'Waits until released or cancelled.', scope: 'read', inputSchema: { type: 'object' },
    handler: (_input, ctx) => new Promise((resolve) => {
      release = () => resolve({ content: [{ type: 'text', text: 'done' }] });
      ctx.signal.addEventListener('abort', () => {
        abortNames.push((ctx.signal.reason as Error).name);
        resolve({ content: [{ type: 'text', text: 'aborted' }] });
      });
    }),
  } satisfies Tool);
  const server = new MCPServer({ version: '0.0.0-test', tools, resources: buildDefaultResourceRegistry(), prompts: buildDefaultPromptRegistry() });
  const sent: JsonRpcMessage[] = [];
  server.attach({ send: (m) => { sent.push(m); } });
  let id = 1;
  const request = (method: string, params?: unknown) =>
    server.handleMessage({ jsonrpc: '2.0', id: id++, method, ...(params !== undefined ? { params } : {}) }) as Promise<Reply>;
  const initialize = () => request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '0' } });
  return { server, sent, request, initialize, release: () => release(), abortNames };
}

describe('SDK protocol adapter lifecycle', () => {
  it('answers tools/call and resources/subscribe without params with -32602', async () => {
    const { request, initialize } = build();
    await initialize();
    expect((await request('tools/call'))?.error?.code).toBe(-32602);
    expect((await request('resources/subscribe'))?.error?.code).toBe(-32602);
    expect((await request('tools/call', { arguments: {} }))?.error?.code).toBe(-32602);
  });

  it('keeps not-initialized and resource-not-found apart', async () => {
    const { request, initialize } = build();
    const early = await request('resources/read', { uri: 'nope://x' });
    expect(early?.error?.code).toBe(-32600);
    // The gate runs before the SDK's param validation.
    expect((await request('tools/call'))?.error?.code).toBe(-32600);
    await initialize();
    expect((await request('resources/read', { uri: 'nope://x' }))?.error).toMatchObject({ code: -32602, data: { uri: 'nope://x' } });
  });

  it('sends no response to a cancelled request and aborts its handler', async () => {
    const { server, sent, initialize } = build();
    await initialize();
    const pending = server.handleMessage({ jsonrpc: '2.0', id: 'slow', method: 'tools/call', params: { name: 'wait', arguments: {} } });
    await new Promise((r) => setTimeout(r, 10));
    await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'slow' } });
    expect(await pending).toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.filter((m) => 'id' in m && m.id === 'slow')).toEqual([]);
  });

  it('answers a second request with an id still in flight with -32600', async () => {
    const { server, initialize, release } = build();
    await initialize();
    const first = server.handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'wait', arguments: {} } });
    await new Promise((r) => setTimeout(r, 10));
    expect((await server.handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/list' }) as Reply)?.error?.code).toBe(-32600);
    release();
    expect((await first as Reply)?.result).toBeDefined();
  });

  it('starts a new connection after detach: uninitialized, no log level, no subscriptions', async () => {
    const { server, sent, request, initialize } = build();
    await initialize();
    await request('logging/setLevel', { level: 'debug' });
    await request('resources/subscribe', { uri: 'ifc-lite://viewer/selection' });
    server.detach();
    server.attach({ send: (m) => { sent.push(m); } });
    sent.length = 0;
    expect((await request('tools/list'))?.error?.code).toBe(-32600);
    await initialize();
    server.notifyResourceUpdated('ifc-lite://viewer/selection');
    await request('tools/list');
    expect(sent.map((m) => (m as { method?: string }).method)).toEqual([]);
  });

  it('answers requests the SDK envelope schema refuses with -32600 instead of hanging', async () => {
    const { server, initialize } = build();
    await initialize();
    const send = (message: unknown) => server.handleMessage(message as JsonRpcMessage) as Promise<Reply>;
    expect((await send({ jsonrpc: '2.0', id: 1.5, method: 'tools/list' }))?.error?.code).toBe(-32600);
    expect((await send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: [] }))?.error?.code).toBe(-32600);
    expect((await send({ jsonrpc: '2.0', id: null, method: 'tools/list' }))?.error?.code).toBe(-32600);
    // The id is free again afterwards.
    expect((await send({ jsonrpc: '2.0', id: 3, method: 'tools/list' }))?.result).toBeDefined();
  });

  it('turns a tool result the spec refuses into an INTERNAL_ERROR tool result, not -32602', async () => {
    const { request, initialize } = build();
    await initialize();
    const reply = await request('tools/call', { name: 'bad_result', arguments: {} });
    expect(reply?.error).toBeUndefined();
    expect(reply?.result).toMatchObject({ isError: true, structuredContent: { code: 'INTERNAL_ERROR' } });
  });

  it('aborts the tool with an AbortError and keeps a reused id off the cancelled request', async () => {
    const { server, initialize, abortNames } = build();
    await initialize();
    const first = server.handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'wait', arguments: {} } });
    await new Promise((r) => setTimeout(r, 10));
    // Same chunk on stdio: the cancel, then a new request reusing the id.
    void server.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 5, reason: 'user' } });
    const reused = server.handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/list' }) as Promise<Reply>;
    expect((await reused)?.error?.code).toBe(-32600);
    expect(await first).toBeNull();
    expect(abortNames).toEqual(['AbortError']);
  });

  it('serves a request pipelined right behind initialize, as before the SDK', async () => {
    const { server } = build();
    const init = server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    const list = server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as Promise<Reply>;
    await init;
    expect((await list)?.result).toBeDefined();
  });

  it('never leaves a request hanging when the cancel lands just after its handler returned', async () => {
    for (let ticks = 0; ticks < 12; ticks++) {
      const { server, initialize, release } = build();
      await initialize();
      const call = server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait', arguments: {} } });
      await new Promise((r) => setTimeout(r, 5));
      release();
      for (let i = 0; i < ticks; i++) await Promise.resolve();
      await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
      const settled = await Promise.race([call.then(() => true), new Promise((r) => setTimeout(() => r(false), 200))]);
      expect(settled, `cancel after ${ticks} microtasks`).toBe(true);
    }
  });

  it('answers requests still in flight at detach with an error, not as cancelled', async () => {
    const { server, initialize } = build();
    await initialize();
    const call = server.handleMessage({ jsonrpc: '2.0', id: 'd', method: 'tools/call', params: { name: 'wait', arguments: {} } });
    await new Promise((r) => setTimeout(r, 10));
    server.detach();
    expect(((await call) as Reply)?.error?.code).toBe(-32603);
  });

  it('keeps the gate closed after a refused initialize', async () => {
    const { request } = build();
    expect((await request('initialize', {}))?.error?.code).toBe(-32602);
    expect((await request('tools/list'))?.error?.code).toBe(-32600);
  });

  it('settles a request sent before initialize and cancelled in the same tick', async () => {
    const { server } = build();
    const early = server.handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
    void server.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 5 } });
    const settled = await Promise.race([early.then(() => true), new Promise((r) => setTimeout(() => r(false), 200))]);
    expect(settled).toBe(true);
  });

  it('stays initialized when a second, refused initialize races a successful one', async () => {
    const { server, request } = build();
    const init = (id: number, protocolVersion: unknown) => server.handleMessage({ jsonrpc: '2.0', id, method: 'initialize',
      params: { protocolVersion, capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    await Promise.all([init(1, PROTOCOL_VERSION), init(2, 5)]);
    expect(server.isInitialized()).toBe(true);
    expect((await request('tools/list'))?.result).toBeDefined();
  });

  it('a cancelled initialize leaves the connection uninitialized, not half open', async () => {
    const { server, request } = build();
    const init = server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    void server.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
    await init;
    // Either the initialize won the race (fully initialized) or it did not (requests refused); never in between.
    const listed = await request('tools/list');
    expect(server.isInitialized() ? listed?.result !== undefined : listed?.error?.code === -32600).toBe(true);
  });

  it('says what params were wrong in one line', async () => {
    const { request, initialize } = build();
    const reply = await request('initialize', { protocolVersion: 5 });
    expect(reply?.error?.code).toBe(-32602);
    expect(reply?.error).toMatchObject({ data: { issues: expect.any(Array) } });
    expect(String((reply?.error as { message?: string }).message)).not.toContain('\n');
    await initialize();
    const call = await request('tools/call', { arguments: {} });
    expect(call?.error).toMatchObject({ code: -32602, data: { issues: expect.any(Array) } });
    expect(String((call?.error as { message?: string }).message)).toMatch(/^Invalid tools\/call request: [^\n]+$/);
  });
});
