/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #9013: storey authoring over JSON-RPC, real Bonsai source, refusals and one Undo per write. */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { readStoreyInventory } from '@ifc-lite/create';
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

async function session(readOnly = false) {
  const registry = new InMemoryModelRegistry();
  registry.add(await loadIfcModel(SAMPLE, { modelId: 'alpha' }));
  const server = new MCPServer({ version: 'test', registry, tools: buildDefaultToolRegistry(), resources: new ResourceRegistry(), prompts: new PromptRegistry(), scope: readOnly ? readOnlyScope() : fullScope() });
  const transport = new InProcessTransport();
  await transport.connect(server);
  let requestId = 0;
  await transport.send({ jsonrpc: '2.0', id: ++requestId, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Storey test', version: 'test' } } });
  return { registry, async call(name: string, input: Record<string, unknown> = {}): Promise<CallToolResult> {
    const response = await transport.send({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name, arguments: input } }) as { result?: CallToolResult };
    if (!response.result) throw new Error('Expected tool result');
    return response.result;
  } };
}

it('#9352 MCP reads a copied top and actual height when floor Elevation differs from placement', async () => {
  const { registry, call } = await session();
  const model = registry.get('alpha')!, S = model.bim.store;
  const home = S.listStoreyLevels('alpha')[0].expressId;
  const middle = S.addStorey('alpha', { Name: 'Middle', Elevation: 3 });
  const upper = S.addStorey('alpha', { Name: 'Upper', Elevation: 6 });
  S.setPositionalAttribute(middle, 9, { real: 2.75 });
  const wall = S.addWall('alpha', home, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: .2, Height: 6,
    TopConstraint: { kind: 'storey', storeyId: upper.expressId } });
  const [copy] = S.copyElements('alpha', [wall.expressId], [{ targetStoreyId: middle.expressId }]);
  const result = await call('get_entity', { express_id: copy.expressId, include: ['properties', 'quantities'] });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent?.properties).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'IfcLite_StoreyAttachment',
    properties: expect.arrayContaining([expect.objectContaining({ name: 'TopConstraint', value: model.bim.entity(upper)!.globalId })]) })]));
  expect(result.structuredContent?.quantities).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Qto_WallBaseQuantities',
    quantities: expect.arrayContaining([expect.objectContaining({ name: 'Height', value: 3 })]) })]));
});

describe('#9013 storey tools', () => {
  it('adds a storey from its neighbour, re-levels it, exports it and undoes each step', async () => {
    const { registry, call } = await session();
    const added = await call('storey_add', { reference_storey_express_id: 42, side: 'above' });
    expect(added.isError).not.toBe(true);
    const id = added.structuredContent?.expressId as number;
    expect(added.structuredContent).toMatchObject({ Name: 'Level 2', Elevation: 3 });

    const plan = await call('storey_plan_edit', { storey_express_id: 42, kind: 'floor_height', value: 3.4 });
    expect(plan.structuredContent?.refusals).toEqual([]);
    expect((plan.structuredContent!.storeys as Array<{ expressId: number; to: number }>).map((s) => [s.expressId, s.to])).toEqual([[id, 3.4]]);

    expect((await call('storey_edit', { storey_express_id: 42, kind: 'floor_height', value: 3.4 })).isError).not.toBe(true);
    const listed = await call('storey_list');
    expect((listed.structuredContent!.storeys as Array<{ Name: string; elevation: number }>).map((s) => [s.Name, s.elevation]))
      .toEqual([['Level 2', 3.4], ['My Storey', 0]]);

    const saved = registry.get('alpha')!.bim.export.ifc();
    const bytes = typeof saved === 'string' ? new TextEncoder().encode(saved) : saved;
    const reloaded = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
    expect(readStoreyInventory(reloaded, new MutablePropertyView(null, 'r')).storeys.map((s) => [s.Name, s.elevation])).toEqual([['My Storey', 0], ['Level 2', 3.4]]);

    expect((await call('mutation_undo')).isError).not.toBe(true);
    expect(((await call('storey_list')).structuredContent!.storeys as Array<{ elevation: number }>)[0].elevation).toBe(3);
  });

  it('reports a refusal with its reason and writes nothing', async () => {
    const { registry, call } = await session();
    await call('storey_add', { Name: 'Upper', Elevation: 3 });
    const view = registry.get('alpha')!.backend.getMutationView()!;
    const before = structuredClone(view.getMutations());
    const refused = await call('storey_edit', { storey_express_id: 42, kind: 'elevation', value: 5 });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain('would pass Upper');
    expect(view.getMutations()).toEqual(before);
    const deleted = await call('storey_delete', { storey_express_id: 42, mode: 'empty' });
    expect(deleted.isError).toBe(true);
    expect(JSON.stringify(deleted.content)).toContain('holds');
  });

  it('keeps writes out of a read-only session but allows the dry runs', async () => {
    const { call } = await session(true);
    expect((await call('storey_list')).isError).not.toBe(true);
    expect((await call('storey_plan_edit', { storey_express_id: 42, kind: 'elevation', value: 1 })).isError).not.toBe(true);
    expect((await call('storey_add', { Name: 'Nope', Elevation: 3 })).isError).toBe(true);
  });
});

it('#9352 storey_plan_add is read-only and returns attachment bindings', async () => {
  const { registry, call } = await session(true);
  const model = registry.get('alpha')!;
  const S = model.bim.store;
  const home = S.listStoreyLevels('alpha')[0].expressId;
  const upper = S.addStorey('alpha', { Name: 'Upper', Elevation: 6 });
  const wall = S.addWall('alpha', home, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: .2, Height: 6, TopConstraint: { kind: 'storeyAbove' } });
  const view = model.backend.getMutationView()!;
  const before = structuredClone({ entities: view.getNewEntities(), mutations: view.getMutations() });
  const plan = await call('storey_plan_add', { Name: 'Middle', Elevation: 3, reference_storey_express_id: home });
  expect(plan.isError).not.toBe(true);
  expect(plan.structuredContent).toMatchObject({ refusal: null, bindings: [expect.objectContaining({ elementId: wall.expressId, previousTargetId: upper.expressId, to: 3 })] });
  expect({ entities: view.getNewEntities(), mutations: view.getMutations() }).toEqual(before);
});

it('#9352 set_top_constraint fits a top and get_entity reads its persisted target', async () => {
  const { registry, call } = await session();
  const model = registry.get('alpha')!, S = model.bim.store;
  const home = S.listStoreyLevels('alpha')[0].expressId;
  const upper = S.addStorey('alpha', { Name: 'Upper', Elevation: 3 });
  const wall = S.addWall('alpha', home, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: .2, Height: 2.5, TopConstraint: { kind: 'fixed' } });
  expect((await call('set_top_constraint', { express_id: wall.expressId, constraint: { kind: 'storeyAbove' } })).isError).not.toBe(true);
  const result = await call('get_entity', { express_id: wall.expressId, include: ['properties'] });
  expect(result.structuredContent!.properties).toEqual(expect.arrayContaining([expect.objectContaining({
    name: 'IfcLite_StoreyAttachment', properties: expect.arrayContaining([expect.objectContaining({ name: 'TopConstraint', value: model.bim.entity(upper)!.globalId })]),
  })]));
  const exported = model.bim.export.ifc();
  const bytes = typeof exported === 'string' ? new TextEncoder().encode(exported) : exported;
  const reopened = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  expect(extractPropertiesOnDemand(reopened, wall.expressId).find(p => p.name === 'IfcLite_StoreyAttachment')?.properties
    .find(p => p.name === 'TopConstraint')?.value).toBe(model.bim.entity(upper)!.globalId);
});

it('#9352 copy_to_storeys returns each floor and keeps copy containment', async () => {
  const { registry, call } = await session();
  const model = registry.get('alpha')!, S = model.bim.store;
  const home = S.listStoreyLevels('alpha')[0].expressId;
  const upper = S.addStorey('alpha', { Name: 'Upper', Elevation: 3 });
  const wall = S.addWall('alpha', home, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: .2, Height: 3 });
  const result = await call('copy_to_storeys', { express_ids: [wall.expressId], storey_express_ids: [upper.expressId] });
  expect(result.isError).not.toBe(true);
  const floors = result.structuredContent!.storeys as Array<{ storeyId: number; entities: Array<{ expressId: number }> }>;
  expect(floors).toHaveLength(1);
  expect(floors[0].storeyId).toBe(upper.expressId);
  expect(floors[0].entities).toHaveLength(1);
  const exported = model.bim.export.ifc();
  const bytes = typeof exported === 'string' ? new TextEncoder().encode(exported) : exported;
  const reopened = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  expect(reopened.spatialHierarchy?.elementToStorey.get(floors[0].entities[0].expressId)).toBe(upper.expressId);
});

it.each([
  ['set_top_constraint', { express_id: 1222, constraint: { kind: 'fixed' } }],
  ['copy_to_storeys', { express_ids: [1222], storey_express_ids: [42] }],
] as const)('#9352 %s refuses a write through a read-only transport', async (name, input) => {
  const { registry, call } = await session(true);
  const model = registry.get('alpha')!;
  model.backend.ensureEditor();
  const view = model.backend.getMutationView()!;
  const before = structuredClone({ entities: view.getNewEntities(), mutations: view.getMutations() });
  const result = await call(name, input);
  expect(result.isError).toBe(true);
  expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringMatching(/scope|permission|read.only/i) })]));
  expect({ entities: view.getNewEntities(), mutations: view.getMutations() }).toEqual(before);
});


it('#9352 the add plan accepts the same relative request as storey_add', async () => {
  const { registry, call } = await session();
  const S = registry.get('alpha')!.bim.store;
  const before = S.listStoreyLevels('alpha');
  const request = { reference_storey_express_id: 42, side: 'below' };
  const plan = await call('storey_plan_add', request);
  expect(plan.isError).not.toBe(true);
  expect(plan.structuredContent).toMatchObject({ refusal: null });
  expect(S.listStoreyLevels('alpha')).toEqual(before);
  const added = await call('storey_add', request);
  expect(added.isError).not.toBe(true);
  expect(added.structuredContent).toMatchObject({ Name: 'Level 2', Elevation: -3 });
});

it('#9352 storey_delete rebinds relative elements and get_entity reads the new target', async () => {
  const { registry, call } = await session();
  const model = registry.get('alpha')!;
  const S = model.bim.store;
  const home = S.listStoreyLevels('alpha')[0].expressId;
  const middle = S.addStorey('alpha', { Name: 'Middle', Elevation: 3 });
  const upper = S.addStorey('alpha', { Name: 'Upper', Elevation: 6 });
  const wall = S.addWall('alpha', home, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: .2, Height: 3, TopConstraint: { kind: 'storeyAbove' } });
  const deleted = await call('storey_delete', { storey_express_id: middle.expressId, mode: 'empty' });
  expect(deleted.isError).not.toBe(true);
  const read = await call('get_entity', { express_id: wall.expressId, include: ['properties', 'quantities'] });
  expect(read.structuredContent!.properties).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'IfcLite_StoreyAttachment', properties: expect.arrayContaining([
      expect.objectContaining({ name: 'TopConstraint', value: model.bim.entity(upper)!.globalId }),
    ]) }),
  ]));
  expect(read.structuredContent?.quantities).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'Qto_WallBaseQuantities', quantities: expect.arrayContaining([
      expect.objectContaining({ name: 'Height', value: 6 }),
    ]) }),
  ]));
});


it.each([
  { kind: 'wall', withOpening: false }, { kind: 'wall', withOpening: true },
  { kind: 'beam', withOpening: false }, { kind: 'member', withOpening: false },
] as const)('#9352 storey_delete reports an impossible pending $kind top without changing the model (opening=$withOpening)', async ({ kind, withOpening }) => {
  const { registry, call } = await session();
  const model = registry.get('alpha')!, S = model.bim.store;
  const lower = S.listStoreyLevels('alpha')[0].expressId;
  S.addStorey('alpha', { Name: 'Middle', Elevation: 3 });
  const home = S.addStorey('alpha', { Name: 'Top', Elevation: 6 });
  const z = withOpening ? -6 : 0;
  const wall = kind === 'wall'
    ? S.addWall('alpha', home.expressId, { Start: [0, 5, z], End: [4, 5, z], Thickness: .2, Height: withOpening ? 4 : 3,
      TopConstraint: { kind: 'storeyAbove' } })
    : S[kind === 'beam' ? 'addBeam' : 'addMember']('alpha', home.expressId,
      { Start: [0, 5, -3], End: [0, 5, -1], Width: .3, Height: .3, TopConstraint: { kind: 'storeyAbove' } });
  if (withOpening) S.addHostedDoor('alpha', wall.expressId, { Offset: 1, Width: .9, Height: 3.5 });
  const view = model.backend.getMutationView()!;
  const before = structuredClone(view.getMutations());
  const result = await call('storey_delete', { storey_express_id: home.expressId, mode: 'move', target_storey_express_id: lower });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toMatch(/top|height|tall|long/i);
  expect(view.getMutations()).toEqual(before);
});
