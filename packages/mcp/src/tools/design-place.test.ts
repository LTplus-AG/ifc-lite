/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: actual JSON-RPC tools, real Bonsai source, atomic graph Undo and federation isolation. */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EntityExtractor, IfcParser } from '@ifc-lite/parser';
import { placedBodyExtent, readHostedElementSize, readHostedFill } from '@ifc-lite/create';
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
const GRID = { UAxes: [{ Tag: 'U', Start: [0, 0], End: [4, 0] }], VAxes: [{ Tag: 'V', Start: [2, -2], End: [2, 2] }] };
const CURTAIN = { Start: [0, 5, 0], End: [4, 5, 0], Height: 3, UGrid: 2, VGrid: 2 };
async function session(count = 1, readOnly = false) {
  const registry = new InMemoryModelRegistry();
  for (const id of ['alpha', 'beta'].slice(0, count)) registry.add(await loadIfcModel(SAMPLE, { modelId: id }));
  const server = new MCPServer({ version: 'test', registry, tools: buildDefaultToolRegistry(), resources: new ResourceRegistry(), prompts: new PromptRegistry(), scope: readOnly ? readOnlyScope() : fullScope() });
  const transport = new InProcessTransport();
  await transport.connect(server);
  let requestId = 0;
  await transport.send({ jsonrpc: '2.0', id: ++requestId, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Design test', version: 'test' } } });
  return { registry, transport, async call(name: string, input: Record<string, unknown> = {}): Promise<CallToolResult> {
    const response = await transport.send({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name, arguments: input } }) as { result?: CallToolResult };
    if (!response.result) throw new Error('Expected tool result');
    return response.result;
  } };
}

describe('#6232 public design placement', () => {
  for (const [kind, params, type] of [['curtain_wall', CURTAIN, 'IFCCURTAINWALL'], ['grid', GRID, 'IFCGRID']] as const) {
    it(`${kind} exports its complete graph and one Undo retains preceding work`, async () => {
      const { registry, call } = await session();
      const model = registry.get('alpha')!;
      const prior = model.backend.ensureEditor().addEntity('IfcCartesianPoint', [[7, 8, 9]]).expressId;
      const view = model.backend.getMutationView()!;
      const before = structuredClone({ records: view.getNewEntities(), journal: view.getMutations() });
      const result = await call(`place_${kind}`, { storey_express_id: 42, params });
      expect(result.isError).not.toBe(true);
      const id = result.structuredContent?.expressId;
      expect(typeof id).toBe('number');
      const saved = model.bim.export.ifc();
      const bytes = typeof saved === 'string' ? new TextEncoder().encode(saved) : saved;
      const parsed = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
      expect(parsed.entityIndex.byType.get(type)).toContain(id);
      expect(parsed.entityIndex.byId.has(prior)).toBe(true);
      if (kind === 'curtain_wall') {
        expect(parsed.entityIndex.byType.get('IFCMEMBER')?.length).toBeGreaterThan(0);
        expect(parsed.entityIndex.byType.get('IFCPLATE')?.length).toBeGreaterThan(0);
        expect(parsed.entityIndex.byType.get('IFCRELAGGREGATES')?.length).toBeGreaterThan(0);
      } else expect(parsed.entityIndex.byType.get('IFCGRIDAXIS')).toHaveLength(2);
      expect((await call('mutation_undo')).isError).not.toBe(true);
      expect({ records: view.getNewEntities(), journal: view.getMutations() }).toEqual(before);
    });
  }

  it('persists a profiled column binding to actual axes and undoes column and grid independently', async () => {
    const { registry, call } = await session();
    const grid = await call('place_grid', { storey_express_id: 42, params: GRID });
    expect(grid.isError).not.toBe(true);
    const model = registry.get('alpha')!, view = model.backend.getMutationView()!;
    const gridId = grid.structuredContent?.expressId as number;
    const axes = view.getNewEntities().filter(e => e.type === 'IfcGridAxis').map(e => e.expressId);
    const before = structuredClone({ records: view.getNewEntities(), journal: view.getMutations() });
    const params = { Position: [2, 0, 0], Profile: { Type: 'Circle', Radius: .2 }, Height: 3 };
    const binding = { GridId: gridId, IntersectingAxes: axes };
    const column = await call('place_grid_column', { storey_express_id: 42, params, binding });
    expect(column.isError).not.toBe(true);
    const saved = model.bim.export.ifc();
    const bytes = typeof saved === 'string' ? new TextEncoder().encode(saved) : saved;
    const parsed = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
    const extractor = new EntityExtractor(parsed.source);
    const intersections = (parsed.entityIndex.byType.get('IFCVIRTUALGRIDINTERSECTION') ?? []).map(id => extractor.extractEntity(parsed.entityIndex.byId.get(id)!)!);
    expect(intersections.some(e => JSON.stringify(e.attributes[0]) === JSON.stringify(axes))).toBe(true);
    expect((await call('mutation_undo')).isError).not.toBe(true);
    expect({ records: view.getNewEntities(), journal: view.getMutations() }).toEqual(before);
    expect((await call('mutation_undo')).isError).not.toBe(true);
    expect(view.getNewEntities()).toEqual([]);
  });

  it('routes equal local IDs to the chosen model and refuses ambiguity, stale bindings and late failures atomically', async () => {
    const { registry, call } = await session(2);
    expect((await call('place_grid', { storey_express_id: 42, params: GRID })).structuredContent?.code).toBe('MODEL_REQUIRED');
    expect((await call('place_grid', { model_id: 'beta', storey_express_id: 42, params: GRID })).isError).not.toBe(true);
    expect(registry.get('alpha')!.backend.getMutationView()).toBeNull();
    const view = registry.get('beta')!.backend.getMutationView()!;
    const before = structuredClone({ records: view.getNewEntities(), journal: view.getMutations() }), next = view.peekNextExpressId();
    for (const input of [
      { model_id: 'beta', storey_express_id: 42, params: { ...CURTAIN, PanelThickness: -1 } },
      { model_id: 'beta', storey_express_id: 42, params: { ...CURTAIN, Start: [0, 5, 2] } },
      { model_id: 'beta', storey_express_id: 42, params: { ...CURTAIN, name: 'alias' } },
    ]) expect((await call('place_curtain_wall', input)).isError).toBe(true);
    const grid = view.getNewEntities().find(e => e.type === 'IfcGrid')!;
    const axes = view.getNewEntities().filter(e => e.type === 'IfcGridAxis').map(e => e.expressId);
    const stale = await call('place_grid_column', { model_id: 'beta', storey_express_id: 42, params: { Position: [2.1, 0, 0], Width: .2, Depth: .3, Height: 3 }, binding: { GridId: grid.expressId, IntersectingAxes: axes } });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent?.message).toMatch(/no longer matches/);
    expect({ records: view.getNewEntities(), journal: view.getMutations() }).toEqual(before);
    expect(view.peekNextExpressId()).toBe(next);
  });

  it('requires canonical fields and omits every design mutation for read-only tokens', async () => {
    const writable = await session();
    expect((await writable.call('place_grid', { storey_express_id: 42, params: { ...GRID, UAxes: [] } })).isError).toBe(true);
    expect((await writable.call('place_grid_column', { storey_express_id: 42, params: { Position: [0, 0, 0], Height: 3 }, binding: { GridId: 1, IntersectingAxes: [2, 3] } })).isError).toBe(true);
    expect(writable.registry.get('alpha')!.backend.getMutationView()).toBeNull();
    const readonly = await session(1, true);
    const listed = await readonly.transport.send({ jsonrpc: '2.0', id: 100, method: 'tools/list' }) as { result: { tools: Array<{ name: string }> } };
    for (const name of ['place_curtain_wall', 'place_grid', 'place_grid_column']) {
      expect(listed.result.tools.some(t => t.name === name)).toBe(false);
      expect((await readonly.call(name, { storey_express_id: 42, params: GRID })).isError).toBe(true);
    }
  });
});

it('#6232 public hosted edit resizes imported physical geometry, isolates federation and undoes one batch', async () => {
  const { registry, call } = await session(2);
  expect((await call('edit_hosted_element', { express_id: 1262, patch: { OverallWidth: 1.2 } })).structuredContent?.code).toBe('MODEL_REQUIRED');
  const model = registry.get('beta')!, original = placedBodyExtent(model.store, 1299), peer = placedBodyExtent(model.store, 1407);
  const result = await call('edit_hosted_element', { model_id: 'beta', express_id: 1262, patch: { OverallWidth: 1.2, OverallHeight: 1.4 } });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ modelId: 'beta', expressId: 1262 });
  const view = model.backend.getMutationView()!;
  expect(readHostedElementSize(model.store, 1262, view)).toEqual({ OverallWidth: 1.2, OverallHeight: 1.4 });
  const cut = placedBodyExtent(model.store, 1299, view)!;
  expect(cut.max[0] - cut.min[0]).toBeCloseTo(1.2);
  expect(placedBodyExtent(model.store, 1407, view)).toEqual(peer);
  const records = structuredClone({ mutations: view.getMutations(), entities: view.getNewEntities() }), next = view.peekNextExpressId();
  for (const patch of [{ OverallWidth: 20 }, {}, { width: 1 }, { Offset: 999 }, { Sill: -10 }]) {
    expect((await call('edit_hosted_element', { model_id: 'beta', express_id: 1262, patch })).isError).toBe(true);
    expect({ mutations: view.getMutations(), entities: view.getNewEntities() }).toEqual(records);
    expect(view.peekNextExpressId()).toBe(next);
  }
  const hosted = readHostedFill(model.store, 1262, view)!;
  expect((await call('edit_hosted_element', { model_id: 'beta', express_id: 1262, patch: { Offset: 2, Sill: .5 } })).isError).not.toBe(true);
  expect(readHostedFill(model.store, 1262, view)!.offset).toBeCloseTo(2);
  expect((await call('mutation_undo', { model_id: 'beta' })).isError).not.toBe(true);
  expect(readHostedFill(model.store, 1262, view)).toEqual(hosted);
  expect((await call('mutation_undo', { model_id: 'beta' })).isError).not.toBe(true);
  expect(placedBodyExtent(model.store, 1299, view)).toEqual(original);
  expect(registry.get('alpha')!.backend.getMutationView()).toBeNull();
  const readonly = await session(1, true);
  expect((await readonly.call('edit_hosted_element', { express_id: 1262, patch: { OverallWidth: 1.2 } })).isError).toBe(true);
});
