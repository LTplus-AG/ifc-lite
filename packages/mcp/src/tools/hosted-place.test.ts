/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: real Bonsai model -> MCP tools -> shared SDK/core -> overlay,
 * undo and STEP export. Models have identical local ids to expose misrouting. */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { placedBodyExtent, readHostOpeningExtents } from '@ifc-lite/create';
import { fullScope, readOnlyScope } from '../auth/scope.js';
import { InMemoryModelRegistry } from '../context.js';
import { loadIfcModel } from '../loader.js';
import { MCPServer } from '../server.js';
import { ResourceRegistry } from '../resources/index.js';
import { PromptRegistry } from '../prompts/index.js';
import { InProcessTransport } from '../transport/in-process.js';
import { buildDefaultToolRegistry } from './index.js';
import { hostedPlaceTools } from './hosted-place.js';
import { validateInput } from '../validate.js';
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


describe('#9936 slab opening schema and dispatch', () => {
  const slabParams = { Position: [2, 3], Width: 1.2, Depth: 0.8, CutDepth: 0.5, Name: 'Shaft' };
  const schema = hostedPlaceTools.find(tool => tool.name === 'place_opening')!.inputSchema;

  it('accepts both complete opening shapes and keeps door/window slab params invalid', () => {
    for (const params of [slabParams, { Offset: 8, Width: 1, Height: 2 }]) {
      expect(validateInput(schema, { host_express_id: WALL, params }).valid).toBe(true);
    }
    for (const tool of hostedPlaceTools.filter(tool => tool.name !== 'place_opening')) {
      expect(validateInput(tool.inputSchema, { host_express_id: WALL, params: slabParams }).valid).toBe(false);
    }
  });

  it.each([
    { Position: [1], Width: 1, Depth: 1 },
    { Position: [1, 2, 3], Width: 1, Depth: 1 },
    { Position: ['1', 2], Width: 1, Depth: 1 },
    { Position: [1, 2], Width: 1 },
    { Position: [1, 2], Depth: 1 },
    { Offset: 1, Width: 1 },
    { ...slabParams, Offset: 1, Height: 2 },
    { ...slabParams, depth: 1 },
  ])('rejects malformed, incomplete or mixed opening params %j', params => {
    expect(validateInput(schema, { host_express_id: WALL, params }).valid).toBe(false);
  });

  it('dispatches a federated overlay slab through SDK opening creation and undoes only its graph', async () => {
    const { registry, call } = await session(2);
    const model = registry.get('beta')!;
    const slab = model.bim.store.addSlab('beta', 42, { Position: [0, 0, 0], Width: 8, Depth: 6, Thickness: 0.3 });
    const view = model.backend.getMutationView()!;
    const before = structuredClone(view.getNewEntities());
    const result = await call('place_opening', { model_id: 'beta', host_express_id: slab.expressId, params: slabParams });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining(`host #${slab.expressId}`) })]));
    const placed = result.structuredContent as { expressId: number; openingId: number; modelId: string };
    expect(placed.modelId).toBe('beta');
    expect(placed.openingId).toBe(placed.expressId);
    const rows = view.getNewEntities().slice(before.length);
    expect(rows.find(e => e.type === 'IfcRelVoidsElement')?.attributes.slice(4)).toEqual([`#${slab.expressId}`, `#${placed.expressId}`]);
    expect(rows.some(e => e.type === 'IfcRelFillsElement')).toBe(false);
    const extent = placedBodyExtent(model.store, placed.expressId, view);
    expect(extent).not.toBeNull();
    expect(extent!.max[0] - extent!.min[0]).toBeCloseTo(1.2);
    expect(extent!.max[1] - extent!.min[1]).toBeCloseTo(0.8);
    expect(extent!.max[2] - extent!.min[2]).toBeCloseTo(0.5);
    const saved = model.bim.export.ifc();
    const bytes = typeof saved === 'string' ? new TextEncoder().encode(saved) : saved;
    const parsed = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
    expect(parsed.entityIndex.byType.get('IFCOPENINGELEMENT')).toContain(placed.expressId);
    expect(registry.get('alpha')!.backend.getMutationView()).toBeNull();
    expect((await call('mutation_undo', { model_id: 'beta' })).isError).not.toBe(true);
    expect(view.getNewEntities()).toEqual(before);
  });
});

it('#9352 MCP and SDK hosted placement preserve distinct operations through MCP attribute readback', async () => {
  const { registry, call } = await session();
  const model = registry.get('alpha')!;
  const home = model.bim.query().byType('IfcBuildingStorey').toArray()[0].ref.expressId;
  const wall = model.bim.store.addWall('alpha', home, { Start: [0, 20, 0], End: [8, 20, 0], Thickness: .2, Height: 3 });
  const result = await call('place_door', { host_express_id: wall.expressId,
    params: { Offset: 2, Width: .9, Height: 2.1, OperationType: 'REVOLVING' } });
  expect(result.isError).not.toBe(true);
  const a = { modelId: 'alpha', expressId: result.structuredContent!.expressId as number };
  const b = model.bim.store.addHostedDoor('alpha', wall.expressId,
    { Offset: 5, Width: .9, Height: 2.1, OperationType: 'revolving' });
  const types = [a, b].map(ref => model.bim.query().byType('IfcDoorType').toArray().find(type =>
    model.bim.related(type.ref, 'IfcRelDefinesByType', 'forward').some(row => row.ref.expressId === ref.expressId))!.ref);
  expect(types[0].expressId).not.toBe(types[1].expressId);
  for (const [i, operation] of ['REVOLVING', 'USERDEFINED'].entries()) {
    const data = await call('get_entity', { express_id: types[i].expressId, include: ['attributes'] });
    expect(data.isError).not.toBe(true);
    const attrs = data.structuredContent!.attributes as Array<{ name: string; value: unknown }>;
    expect(String(attrs.find(row => row.name === 'OperationType')?.value).replace(/\./g, '')).toBe(operation);
    if (i === 1) expect(attrs.find(row => row.name === 'UserDefinedOperationType')?.value).toBe('revolving');
  }
});
