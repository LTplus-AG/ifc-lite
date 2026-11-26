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

  it('counts a tool call as running until its handler settles (HTTP reclaim reads it)', async () => {
    const { server, initialize, release } = build();
    await initialize();
    const pending = server.handleMessage({ jsonrpc: '2.0', id: 'c', method: 'tools/call', params: { name: 'wait', arguments: {} } });
    await new Promise((r) => setTimeout(r, 10));
    expect(server.runningCalls()).toBe(1);
    release();
    await pending;
    expect(server.runningCalls()).toBe(0);
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
});
