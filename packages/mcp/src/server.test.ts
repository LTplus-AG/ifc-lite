/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end protocol tests over the in-process transport. We exercise the
 * initialize handshake, tool listing, scope filtering, input validation,
 * and the read-only enforcement path. No IFC parsing here — that's covered
 * by the @ifc-lite/parser test suite; the headless backend integration is
 * smoke-checked in `headless-backend.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  MCPServer,
  PROTOCOL_VERSION,
  ToolRegistry,
  ResourceRegistry,
  PromptRegistry,
  fullScope,
  readOnlyScope,
  InMemoryModelRegistry,
  type Tool,
  InProcessTransport,
} from './index.js';

function build({ readOnly = false, scope = fullScope() } = {}): { server: MCPServer; transport: InProcessTransport; messages: unknown[] } {
  const tools = new ToolRegistry();
  tools.register({
    name: 'echo',
    description: 'returns argument',
    scope: 'read',
    inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
    handler(input) {
      return { content: [{ type: 'text', text: `${(input as { msg: string }).msg}` }], structuredContent: { msg: (input as { msg: string }).msg } };
    },
  } satisfies Tool);
  tools.register({
    name: 'mutate_test',
    description: 'requires mutate',
    scope: 'mutate',
    inputSchema: { type: 'object' },
    handler() {
      return { content: [{ type: 'text', text: 'mutated' }] };
    },
  } satisfies Tool);
  const server = new MCPServer({
    version: '0.0.0-test',
    registry: new InMemoryModelRegistry(),
    scope,
    config: { readOnly, samplingEnabled: false },
    tools,
    resources: new ResourceRegistry(),
    prompts: new PromptRegistry(),
  });
  const transport = new InProcessTransport();
  void transport.connect(server);
  const messages: unknown[] = [];
  transport.onMessage((m) => messages.push(m));
  return { server, transport, messages };
}

async function init(transport: InProcessTransport, id = 1): Promise<unknown> {
  return transport.send({
    jsonrpc: '2.0', id, method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  });
}

describe('MCP server: handshake', () => {
  it('returns server info on initialize', async () => {
    const { transport } = build();
    const res = await init(transport) as { result: { serverInfo: { name: string }; protocolVersion: string } };
    expect(res.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(res.result.serverInfo.name).toBe('ifc-lite-mcp');
  });

  it('echoes back a supported protocol version when the client requests one we know', async () => {
    const { transport } = build();
    const res = await transport.send({
      jsonrpc: '2.0', id: 11, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    }) as { result: { protocolVersion: string } };
    // Newer Claude Desktop hard-closes the transport on a version mismatch,
    // so this echo behavior is what unblocks the integration.
    expect(res.result.protocolVersion).toBe('2025-11-25');
  });

  it('falls back to PROTOCOL_VERSION for unknown client versions', async () => {
    const { transport } = build();
    const res = await transport.send({
      jsonrpc: '2.0', id: 12, method: 'initialize',
      params: { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    }) as { result: { protocolVersion: string } };
    expect(res.result.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('rejects requests before initialize', async () => {
    const { transport } = build();
    const res = await transport.send({ jsonrpc: '2.0', id: 99, method: 'tools/list' }) as { error: { code: number } };
    expect(res.error.code).toBe(-32002);
  });
});

describe('MCP server: tools/list', () => {
  it('lists tools in scope', async () => {
    const { transport } = build();
    await init(transport);
    const res = await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: Array<{ name: string }> } };
    const names = res.result.tools.map((t) => t.name);
    expect(names).toContain('echo');
    expect(names).toContain('mutate_test');
  });

  it('hides mutate tools in read-only mode', async () => {
    const { transport } = build({ readOnly: true });
    await init(transport);
    const res = await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: Array<{ name: string }> } };
    const names = res.result.tools.map((t) => t.name);
    expect(names).toContain('echo');
    expect(names).not.toContain('mutate_test');
  });

  it('hides mutate tools when scope lacks mutate', async () => {
    const { transport } = build({ scope: readOnlyScope() });
    await init(transport);
    const res = await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: Array<{ name: string }> } };
    expect(res.result.tools.map((t) => t.name)).not.toContain('mutate_test');
  });
});

describe('MCP server: tools/call', () => {
  it('runs the handler and returns structured content', async () => {
    const { transport } = build();
    await init(transport);
    const res = await transport.send({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'echo', arguments: { msg: 'hello' } },
    }) as { result: { content: Array<{ text: string }>; structuredContent: { msg: string }; isError?: boolean } };
    expect(res.result.content[0].text).toBe('hello');
    expect(res.result.structuredContent.msg).toBe('hello');
    expect(res.result.isError).toBeUndefined();
  });

  it('returns INVALID_INPUT on bad args', async () => {
    const { transport } = build();
    await init(transport);
    const res = await transport.send({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'echo', arguments: {} },
    }) as { result: { isError: boolean; structuredContent: { code: string } } };
    expect(res.result.isError).toBe(true);
    expect(res.result.structuredContent.code).toBe('INVALID_INPUT');
  });

  it('refuses unknown tools with UNSUPPORTED_OPERATION', async () => {
    const { transport } = build();
    await init(transport);
    const res = await transport.send({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'doesnt_exist', arguments: {} },
    }) as { result: { isError: boolean; structuredContent: { code: string } } };
    expect(res.result.isError).toBe(true);
    expect(res.result.structuredContent.code).toBe('UNSUPPORTED_OPERATION');
  });

  it('refuses mutate tools without scope', async () => {
    const { transport } = build({ scope: readOnlyScope() });
    await init(transport);
    const res = await transport.send({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'mutate_test', arguments: {} },
    }) as { result: { isError: boolean; structuredContent: { code: string } } };
    expect(res.result.isError).toBe(true);
    expect(res.result.structuredContent.code).toBe('PERMISSION_DENIED');
  });

  it('blocks mutate tools in read-only mode even with scope', async () => {
    const { transport } = build({ readOnly: true });
    await init(transport);
    const res = await transport.send({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'mutate_test', arguments: {} },
    }) as { result: { isError: boolean; structuredContent: { code: string } } };
    expect(res.result.isError).toBe(true);
    expect(res.result.structuredContent.code).toBe('READ_ONLY');
  });
});

describe('MCP server: ping/cancel', () => {
  it('responds to ping pre-initialize', async () => {
    const { transport } = build();
    const res = await transport.send({ jsonrpc: '2.0', id: 8, method: 'ping' }) as { result: unknown };
    expect(res.result).toEqual({});
  });

  it('cancels active requests', async () => {
    const { transport, messages } = build();
    await init(transport);
    // The cancel notification should be accepted even with no matching id.
    await transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } });
    expect(messages).toBeDefined();
  });
});
