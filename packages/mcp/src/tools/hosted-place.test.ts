/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: real Bonsai model -> MCP tools -> shared SDK/core -> overlay,
 * undo and STEP export. Models have identical local ids to expose misrouting. */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { readHostOpeningExtents } from '@ifc-lite/create';
import { fullScope, readOnlyScope } from '../auth/scope.js';
import { InMemoryModelRegistry } from '../context.js';
import { loadIfcModel } from '../loader.js';
import { MCPServer } from '../server.js';
import { ResourceRegistry } from '../resources/index.js';
import { PromptRegistry } from '../prompts/index.js';
import { InProcessTransport } from '../transport/in-process.js';
import { buildDefaultToolRegistry } from './index.js';
import type { CallToolResult } from '../protocol/index.js';

const SAMPLE = fileURLToPath(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
const WALL = 1222;
const GUID = '1NewDo0rGuidAbCdEf$_09';
const PARAMS = { Offset: 8, Width: 0.9, Height: 2.1, Name: 'D5 door', GlobalId: GUID };

async function session(count = 1, readOnly = false) {
  const registry = new InMemoryModelRegistry();
  for (const id of ['alpha', 'beta'].slice(0, count)) registry.add(await loadIfcModel(SAMPLE, { modelId: id }));
  const server = new MCPServer({ version: 'test', registry, tools: buildDefaultToolRegistry(), resources: new ResourceRegistry(), prompts: new PromptRegistry(), scope: readOnly ? readOnlyScope() : fullScope() });
  const transport = new InProcessTransport();
  await transport.connect(server);
  let requestId = 0;
  await transport.send({ jsonrpc: '2.0', id: ++requestId, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'D5 test', version: 'test' },
  } });
  return {
    registry, transport,
    async call(name: string, input: Record<string, unknown> = {}): Promise<CallToolResult> {
      const response = await transport.send({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name, arguments: input } }) as { result?: CallToolResult; error?: unknown };
      if (!response.result) throw new Error(`No tool result: ${JSON.stringify(response.error)}`);
      return response.result;
    },
  };
}

describe('#6232 D5 MCP hosted placement', () => {
  it('writes the real void/fill/containment graph and exports a reparsable door', async () => {
    const { registry, call } = await session();
    const result = await call('place_door', { host_express_id: WALL, params: PARAMS });
    expect(result.isError).not.toBe(true);
    const placed = result.structuredContent as { expressId: number; openingId: number; modelId: string };
    expect(placed.modelId).toBe('alpha');
    const model = registry.get('alpha')!;
    const view = model.backend.getMutationView()!;
    expect(view.getNewEntity(placed.expressId)?.type).toBe('IfcDoor');
    expect(view.getNewEntity(placed.openingId)?.type).toBe('IfcOpeningElement');
    const rows = view.getNewEntities();
    expect(rows.find(e => e.type === 'IfcRelVoidsElement')?.attributes.slice(4)).toEqual([`#${WALL}`, `#${placed.openingId}`]);
    expect(rows.find(e => e.type === 'IfcRelFillsElement')?.attributes.slice(4)).toEqual([`#${placed.openingId}`, `#${placed.expressId}`]);
    const saved = model.bim.export.ifc();
    const bytes = typeof saved === 'string' ? new TextEncoder().encode(saved) : saved;
    const parsed = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
    expect(parsed.entityIndex.byType.get('IFCDOOR')).toContain(placed.expressId);
    expect(parsed.entityIndex.byType.get('IFCOPENINGELEMENT')).toContain(placed.openingId);
    expect(parsed.entityIndex.byType.get('IFCRELFILLSELEMENT')).toHaveLength(3);
  });

  it('one undo removes the complete graph and preserves an earlier raw mutation', async () => {
    const { registry, call } = await session();
    const raw = await call('entity_create', { type: 'IfcCartesianPoint', attributes: [[1, 2, 3]] });
    const rawId = raw.structuredContent?.expressId as number;
    await call('place_door', { host_express_id: WALL, params: PARAMS });
    const model = registry.get('alpha')!;
    expect(model.backend.getMutationView()!.getNewEntities().length).toBeGreaterThan(2);
    const undone = await call('mutation_undo');
    expect(undone.isError).not.toBe(true);
    expect(model.backend.getMutationView()!.getNewEntities().map(e => e.expressId)).toEqual([rawId]);
    expect(model.backend.getMutationView()!.getMutations().map(m => m.entityId)).toEqual([rawId]);
    // Undo released occupancy as well as entities; placing there again succeeds.
    expect((await call('place_door', { host_express_id: WALL, params: PARAMS })).isError).not.toBe(true);
  });

  it('MCP and direct SDK calls observe the same source/overlay overlap and fit refusals', async () => {
    const { registry, call } = await session();
    await call('place_door', { host_express_id: WALL, params: PARAMS });
    const model = registry.get('alpha')!;
    const before = model.backend.getMutationView()!.getNewEntities().length;
    expect(() => model.bim.store.addHostedWindow('alpha', WALL, { Offset: 8, Sill: 1, Width: 1, Height: 1 })).toThrow(/overlaps opening/);
    const overlap = await call('place_opening', { host_express_id: WALL, params: { Offset: 8, Width: 1, Height: 1 } });
    expect(overlap.isError).toBe(true);
    expect(overlap.structuredContent?.message).toMatch(/overlaps opening/);
    const outside = await call('place_door', { host_express_id: WALL, params: { ...PARAMS, GlobalId: undefined, Offset: 10 } });
    expect(outside.isError).toBe(true);
    expect(outside.structuredContent?.message).toMatch(/doesn't fit/);
    expect(model.backend.getMutationView()!.getNewEntities()).toHaveLength(before);
    expect(readHostOpeningExtents(model.store, WALL, model.backend.getMutationView()).unreadable).toEqual([]);
  });

  it('requires a model in federation and targets local/overlay ids in that model alone', async () => {
    const { registry, call } = await session(2);
    const missing = await call('place_door', { host_express_id: WALL, params: PARAMS });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent?.code).toBe('MODEL_REQUIRED');
    const placed = await call('place_window', { model_id: 'beta', host_express_id: WALL, params: { Offset: 8, Width: 1, Height: 1, Sill: 1 } });
    expect(placed.isError).not.toBe(true);
    expect(placed.structuredContent?.modelId).toBe('beta');
    expect(registry.get('alpha')!.backend.getMutationView()).toBeNull();
    const beta = registry.get('beta')!;
    expect(() => beta.bim.store.addHostedDoor('alpha', WALL, PARAMS)).toThrow(/Unknown modelId/);
    expect(beta.backend.getMutationView()!.getNewEntities().filter(e => e.type === 'IfcWindow')).toHaveLength(1);
  });

  it('validates required window sill and rejects lower-case EXPRESS attributes', async () => {
    const { registry, call } = await session();
    const missing = await call('place_window', { host_express_id: WALL, params: { Offset: 8, Width: 1, Height: 1 } });
    expect(missing.isError).toBe(true);
    const alias = await call('place_door', { host_express_id: WALL, params: { Offset: 8, Width: 1, Height: 2, name: 'alias' } });
    expect(alias.isError).toBe(true);
    expect(registry.get('alpha')!.backend.getMutationView()).toBeNull();
  });

  it('does not advertise or execute the commands for a read-only token', async () => {
    const { call, transport } = await session(1, true);
    const listed = await transport.send({ jsonrpc: '2.0', id: 100, method: 'tools/list' }) as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.some(t => t.name === 'place_door')).toBe(false);
    expect((await call('place_door', { host_express_id: WALL, params: PARAMS })).isError).toBe(true);
  });
});
