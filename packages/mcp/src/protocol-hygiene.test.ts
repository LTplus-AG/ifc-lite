/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The wire protocol says only what the server does (#11535): a real protocol
 * revision, spec prompt roles, working logging and list_changed, templates
 * in resources/templates/list, -32602 for unknown names, scope under _meta,
 * no always-failing stubs, and hints visible without structured output.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  MCPServer,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  ToolRegistry,
  InMemoryModelRegistry,
  InProcessTransport,
  buildDefaultResourceRegistry,
  buildDefaultToolRegistry,
  buildDefaultPromptRegistry,
  fullScope,
  readOnlyScope,
  SILENT_LOGGER,
  type LoadedModel,
  type ModelRegistry,
  type Tool,
} from './index.js';
import { allPrompts } from './prompts/templates.js';
import { ClientLogForwarder } from './client-logging.js';
import { toCatalogEntry } from './tool-catalog.js';
import { toolError, ToolErrorCode } from './errors.js';
import type { ContentBlock, ToolDefinition } from './protocol/index.js';

type Note = { method?: string; params?: Record<string, unknown> };

const fakeModel = (id: string, name = id): LoadedModel => ({
  id, name, loadedAt: 0,
  backend: { setPeerScopes() { /* no peers */ }, dispose() { /* nothing held */ } },
} as unknown as LoadedModel);

function build({ readOnly = false, registry = new InMemoryModelRegistry() as ModelRegistry } = {}) {
  const tools = new ToolRegistry();
  tools.register({
    name: 'load_fake', description: 'Adds a model. Second sentence.', scope: 'mutate',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    handler(input) { registry.add(fakeModel(String(input.id))); return { content: [{ type: 'text', text: 'ok' }] }; },
  } satisfies Tool);
  tools.register({
    name: 'log_both', title: 'Log both', description: 'Logs info and error.', scope: 'read',
    inputSchema: { type: 'object' },
    handler(_input, ctx) {
      ctx.log.log('info', 'quiet line');
      ctx.log.log('error', 'loud line', { n: 1 });
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  } satisfies Tool);
  const server = new MCPServer({
    version: '0.0.0-test', registry, config: { readOnly, samplingEnabled: false },
    tools, resources: buildDefaultResourceRegistry(), prompts: buildDefaultPromptRegistry(),
  });
  const transport = new InProcessTransport();
  void transport.connect(server);
  const notes: Note[] = [];
  transport.onMessage((m) => notes.push(m as Note));
  let id = 1;
  const request = (method: string, params?: unknown) =>
    transport.send({ jsonrpc: '2.0', id: id++, method, ...(params !== undefined ? { params } : {}) }) as Promise<{
      result?: Record<string, unknown>; error?: { code: number; message: string };
    }>;
  return { server, request, notes };
}

async function initialized(opts?: Parameters<typeof build>[0]) {
  const h = build(opts);
  const res = await h.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '0' } });
  return { ...h, init: res.result as { instructions: string; capabilities: Record<string, unknown> } };
}

const methods = (notes: Note[], method: string) => notes.filter((n) => n.method === method);

describe('protocol version', () => {
  it('defaults to a published MCP revision and no longer offers 2025-11-05', async () => {
    expect(PROTOCOL_VERSION).toBe('2025-11-25');
    expect(SUPPORTED_PROTOCOL_VERSIONS.has('2025-11-05')).toBe(false);
    const { request } = build();
    const res = await request('initialize', { protocolVersion: '2025-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    expect(res.result?.protocolVersion).toBe('2025-11-25');
  });
});

describe('prompts', () => {
  it('render only user and assistant messages', async () => {
    const { server } = build();
    for (const prompt of allPrompts) {
      const args = Object.fromEntries((prompt.arguments ?? []).map((a) => [a.name, 'x']));
      const rendered = await prompt.render(args, {} as Parameters<typeof prompt.render>[1]);
      for (const m of rendered.messages) expect(['user', 'assistant'], `${prompt.name}`).toContain(m.role);
    }
    expect(server.prompts.list().length).toBe(allPrompts.length);
  });

  it('answers an unknown prompt name with -32602', async () => {
    const { request } = await initialized();
    expect((await request('prompts/get', { name: 'nope' })).error?.code).toBe(-32602);
  });
});

describe('logging', () => {
  it('forwards nothing until the client sets a level, then only lines at or above it', async () => {
    const { request, notes } = await initialized();
    await request('tools/call', { name: 'log_both', arguments: {} });
    expect(methods(notes, 'notifications/message')).toHaveLength(0);

    expect((await request('logging/setLevel', { level: 'error' })).result).toEqual({});
    await request('tools/call', { name: 'log_both', arguments: {} });
    const sent = methods(notes, 'notifications/message');
    expect(sent.map((n) => n.params?.level)).toEqual(['error']);
    expect(sent[0].params).toMatchObject({ logger: 'ifc-lite-mcp', data: { message: 'loud line', data: { n: 1 } } });
  });

  it('keeps both the log message and a data.message key', () => {
    const sent: unknown[] = [];
    const forwarder = new ClientLogForwarder(SILENT_LOGGER, 'x', (p) => sent.push(p));
    forwarder.setLevel('debug');
    forwarder.logger.log('error', 'export failed', { message: 'disk full' });
    expect(sent).toEqual([{ level: 'error', logger: 'x', data: { message: 'export failed', data: { message: 'disk full' } } }]);
  });

  it('answers -32601 when logging is not advertised', async () => {
    const server = new MCPServer({ version: '0', tools: new ToolRegistry(), resources: buildDefaultResourceRegistry(), prompts: buildDefaultPromptRegistry(), capabilities: { tools: {} } });
    const transport = new InProcessTransport();
    void transport.connect(server);
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    expect(await transport.send({ jsonrpc: '2.0', id: 2, method: 'logging/setLevel', params: { level: 'debug' } })).toMatchObject({ error: { code: -32601 } });
  });

  it('refuses an unknown level with -32602', async () => {
    const { request } = await initialized();
    expect((await request('logging/setLevel', { level: 'loud' })).error?.code).toBe(-32602);
    expect((await request('logging/setLevel')).error?.code).toBe(-32602);
  });
});

describe('list_changed', () => {
  it('sends resources/list_changed when a tool call changes the loaded models, and not otherwise', async () => {
    const { request, notes } = await initialized();
    await request('tools/call', { name: 'log_both', arguments: {} });
    expect(methods(notes, 'notifications/resources/list_changed')).toHaveLength(0);
    await request('tools/call', { name: 'load_fake', arguments: { id: 'a' } });
    expect(methods(notes, 'notifications/resources/list_changed')).toHaveLength(1);
    // Reloading the same id replaces the model but leaves the listed set alone.
    await request('tools/call', { name: 'load_fake', arguments: { id: 'a' } });
    expect(methods(notes, 'notifications/resources/list_changed')).toHaveLength(1);
  });

  it('sends no list_changed before initialize', async () => {
    const { server, notes } = build();
    server.registry.add(fakeModel('early'));
    server.setScope(readOnlyScope());
    expect(notes.filter((n) => n.method?.endsWith('list_changed'))).toEqual([]);
  });

  it('sends resources/list_changed for a registry change made outside any tool call', async () => {
    const { server, notes } = await initialized();
    server.registry.add(fakeModel('host-loaded'));
    server.registry.remove('host-loaded');
    expect(methods(notes, 'notifications/resources/list_changed')).toHaveLength(2);
    server.registry.add(fakeModel('host-loaded', 'renamed'));
    server.registry.add(fakeModel('host-loaded', 'renamed again'));
    // Same id, new name: the listed resource names change too.
    expect(methods(notes, 'notifications/resources/list_changed')).toHaveLength(4);
    server.detach();
    server.registry.add(fakeModel('after-detach'));
    expect(methods(notes, 'notifications/resources/list_changed')).toHaveLength(4);
  });

  it('still sends resources/list_changed after a tool call when the registry has no onChange', async () => {
    const models = new Map<string, LoadedModel>();
    const registry = {
      list: () => [...models.values()], get: (id: string) => models.get(id) ?? null,
      resolve: () => null, add: (m: LoadedModel) => { models.set(m.id, m); },
      remove: (id: string) => models.delete(id), count: () => models.size,
    };
    const { request, notes } = await initialized({ registry });
    await request('tools/call', { name: 'load_fake', arguments: { id: 'm' } });
    expect(methods(notes, 'notifications/resources/list_changed')).toHaveLength(1);
  });

  it('sends tools/list_changed when setScope changes the visible tools, and not otherwise', async () => {
    const { server, notes } = await initialized();
    server.setScope(fullScope());
    expect(methods(notes, 'notifications/tools/list_changed')).toHaveLength(0);
    server.setScope(readOnlyScope());
    expect(methods(notes, 'notifications/tools/list_changed')).toHaveLength(1);
  });
});

describe('instructions and manifest', () => {
  it('keeps the instructions under 4 KB and names only registered tools', async () => {
    const { init } = await initialized();
    expect(new TextEncoder().encode(init.instructions).length).toBeLessThan(4096);
    expect(init.instructions).not.toMatch(/All tools accept/);
    const registered = new Set(buildDefaultToolRegistry().list().map((t) => t.name));
    const named = [...init.instructions.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)].map((m) => m[0]);
    const notTools = new Set(['model_id', 'global_id', 'express_id', 'list_changed', 'spatial-tree', 'property-sets']);
    expect(named.filter((n) => !registered.has(n) && !notTools.has(n))).toEqual([]);
  });

  it('serves a tool catalog in the server manifest, filtered like tools/list', async () => {
    const read = async (readOnly: boolean) => {
      const { request } = await initialized({ readOnly });
      const res = await request('resources/read', { uri: 'ifc-lite://server/manifest' });
      const contents = res.result?.contents as Array<{ text: string }>;
      return (JSON.parse(contents[0].text) as { tools: unknown[] }).tools;
    };
    expect(await read(false)).toEqual([
      { name: 'load_fake', purpose: 'Adds a model.', scope: 'mutate' },
      { name: 'log_both', title: 'Log both', purpose: 'Logs info and error.', scope: 'read' },
    ]);
    expect(await read(true)).toEqual([{ name: 'log_both', title: 'Log both', purpose: 'Logs info and error.', scope: 'read' }]);
  });

  it('does not cut a purpose at an abbreviation', () => {
    const entry = (description: string) => toCatalogEntry({ name: 't', description, inputSchema: {}, handler: () => ({ content: [] }) });
    expect(entry('Class details for a name (e.g. "IfcWall") from bSDD.').purpose).toBe('Class details for a name (e.g. "IfcWall") from bSDD.');
    expect(entry('First. Second.').purpose).toBe('First.');
    expect(entry('Property sets for an entity (e.g. Pset_WallCommon for IfcWall).').purpose).toBe('Property sets for an entity (e.g. Pset_WallCommon for IfcWall).');
    expect(entry('A sentence wrapped\nover two lines. Then more.').purpose).toBe('A sentence wrapped over two lines.');
  });
});

describe('resources', () => {
  it('lists the entity URI as a template, not as a concrete resource', async () => {
    const { request } = await initialized();
    const listed = (await request('resources/list')).result?.resources as Array<{ uri: string }>;
    expect(listed.filter((r) => r.uri.includes('{'))).toEqual([]);
    const templates = (await request('resources/templates/list')).result?.resourceTemplates as Array<{ uriTemplate: string }>;
    expect(templates.map((t) => t.uriTemplate)).toEqual(['ifc-lite://model/{model_id}/entity/{global_id}']);
  });

  it('answers a missing resource with -32002 and a missing uri with -32602', async () => {
    const { request } = await initialized();
    expect((await request('resources/read', { uri: 'nope://x' })).error).toMatchObject({ code: -32002, data: { uri: 'nope://x' } });
    expect((await request('resources/read', { uri: 'ifc-lite://model/missing/manifest' })).error?.code).toBe(-32002);
    expect((await request('resources/read')).error?.code).toBe(-32602);
    expect((await request('prompts/get')).error?.code).toBe(-32602);
  });

  it('types resource_link per spec, beside the embedded resource', () => {
    expectTypeOf({ type: 'resource_link' as const, uri: 'ifc-lite://x', name: 'x' }).toMatchTypeOf<ContentBlock>();
    expectTypeOf({ type: 'resource' as const, resource: { uri: 'ifc-lite://x', text: '{}' } }).toMatchTypeOf<ContentBlock>();
  });
});

describe('tools', () => {
  it('puts scope under _meta, not on the definition', async () => {
    const { request } = await initialized();
    const tools = (await request('tools/list')).result?.tools as Array<ToolDefinition & Record<string, unknown>>;
    for (const t of tools) {
      expect(t).not.toHaveProperty('scope');
      expect(t._meta?.['ifc-lite/scope']).toBeDefined();
    }
  });

  it('no longer advertises the always-failing stubs', () => {
    const names = buildDefaultToolRegistry().list().map((t) => t.name);
    expect(names).not.toContain('export_pdf_report');
    expect(names).not.toContain('gherkin_check');
  });

  it('puts the hint in the text content too', () => {
    const res = toolError({ code: ToolErrorCode.MODEL_REQUIRED, message: 'Pick a model.', hint: 'Pass model_id.' });
    expect(res.content[0]).toEqual({ type: 'text', text: 'Pick a model.\nHint: Pass model_id.' });
    expect(toolError({ code: ToolErrorCode.INTERNAL_ERROR, message: 'Boom.' }).content[0]).toEqual({ type: 'text', text: 'Boom.' });
  });
});
