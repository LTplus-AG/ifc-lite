/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: missing typed SDK methods and actual public run_flow routes are
 * separate contracts. Canonical Bonsai/native controls establish valid input. */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  addRailingToStore, addStairToStore, resolveSpatialAnchor,
  type RailingInStoreParams, type StairInStoreParams,
} from '@ifc-lite/create';
import { StoreEditor } from '@ifc-lite/mutations';
import { EntityExtractor, getSchemaRegistryForVersion, IfcParser } from '@ifc-lite/parser';
import { createBimContext, type EntityRef } from '@ifc-lite/sdk';
import { MemoryTrackingStore, runFlow, type FlowDocument } from '@ifc-lite/flow';
import { createStandardRegistry, headlessFeatures, type FlowHost } from '@ifc-lite/flow-nodes';
import { createMCPServer, fullScope, InMemoryModelRegistry, InProcessTransport,
  loadIfcModel, type CallToolResult } from '@ifc-lite/mcp';
import { meshStairs, stairMeshBounds, stairWasmAvailable } from '../../create/src/in-store/__test__/stair-mesh.oracle.js';
import { HeadlessBackend } from './headless-backend.js';

type Bim = ReturnType<typeof createBimContext>;
type Kind = 'stair' | 'railing';
const SAMPLE = fileURLToPath(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
const AVAILABLE = existsSync(SAMPLE) && stairWasmAvailable;
if (!AVAILABLE) console.warn('skip: restore public Bonsai hello-wall.ifc and run pnpm build:wasm');
const STAIR: StairInStoreParams = { Position: [1, 2, 0], NumberOfRisers: 4,
  RiserHeight: .2, TreadLength: .3, Width: 1, Name: 'D5 stair' };
const RAILING: RailingInStoreParams = { Path: [[1, 2, 0], [3, 2, 0]],
  Height: 1.1, RailDiameter: .1, PostDiameter: .1, PostSpacing: 1, Name: 'D5 railing' };

function add(bim: Bim, model: string, kind: Kind): EntityRef {
  return kind === 'stair' ? bim.store.addStair(model, 42, STAIR) : bim.store.addRailing(model, 42, RAILING);
}
async function records(content: string | Uint8Array) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  const extractor = new EntityExtractor(store.source);
  return { store, all: [...store.entityIndex.byId].map(([id, location]) => {
    const entity = extractor.extractEntity(location);
    if (!entity) throw new Error(`Could not decode actual IFC record #${id}`);
    return [id, entity] as const;
  }).sort((a, b) => a[0] - b[0]) };
}
async function assertProduct(bim: Bim, ref: EntityRef, kind: Kind) {
  const exported = bim.export.ifc();
  const content = typeof exported === 'string' ? exported : new TextDecoder().decode(exported);
  const saved = await records(content), byId = new Map(saved.all);
  const schema = saved.store.schemaVersion;
  if (schema !== 'IFC2X3' && schema !== 'IFC4' && schema !== 'IFC4X3') throw new Error(`Unexpected schema ${schema}`);
  const registry = getSchemaRegistryForVersion(schema);
  const field = (id: number, type: string, name: string) => {
    const entity = byId.get(id), attributes = registry.entities[type]?.allAttributes;
    if (!entity || !attributes) throw new Error(`Missing actual ${type} #${id} or schema attribute table`);
    const index = attributes.findIndex(a => a.name === name);
    expect(entity.type).toBe(type.toUpperCase());
    expect(index).toBeGreaterThanOrEqual(0);
    return entity.attributes[index];
  };
  const type = kind === 'stair' ? 'IfcStair' : 'IfcRailing';
  expect(field(ref.expressId, type, 'Name')).toBe(kind === 'stair' ? STAIR.Name : RAILING.Name);
  const contained = saved.all.filter(([, e]) => e.type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE' && Array.isArray(e.attributes[4]) && e.attributes[4].includes(ref.expressId));
  expect(contained).toHaveLength(1);
  expect(contained[0][1].attributes[5]).toBe(42);
  let meshedId = ref.expressId;
  if (kind === 'stair') {
    const aggregate = saved.all.filter(([, e]) => e.type === 'IFCRELAGGREGATES' && e.attributes[4] === ref.expressId);
    expect(aggregate).toHaveLength(1);
    const parts = aggregate[0][1].attributes[5];
    if (!Array.isArray(parts) || parts.length !== 1 || typeof parts[0] !== 'number') throw new Error('Stair must aggregate one actual flight');
    meshedId = parts[0];
    expect(field(meshedId, 'IfcStairFlight', schema === 'IFC2X3' ? 'NumberOfRiser' : 'NumberOfRisers')).toBe(4);
    expect(field(meshedId, 'IfcStairFlight', 'NumberOfTreads')).toBe(4);
    expect(field(meshedId, 'IfcStairFlight', 'RiserHeight')).toBeCloseTo(.2, 8);
    expect(field(meshedId, 'IfcStairFlight', 'TreadLength')).toBeCloseTo(.3, 8);
  }
  const meshes = (await meshStairs(content)).get(meshedId);
  expect(meshes?.length).toBeGreaterThan(0);
  const triangles = meshes!.reduce((n, m) => n + m.indices.length / 3, 0);
  expect(triangles).toBeGreaterThan(0);
  const box = stairMeshBounds(meshes!);
  const min = kind === 'stair' ? [1, 2, 0] : [.95, 1.95, 0];
  const max = kind === 'stair' ? [2.2, 3, .8] : [3.05, 2.05, 1.1];
  for (let axis = 0; axis < 3; axis++) {
    expect(box.min[axis]).toBeCloseTo(min[axis], 4);
    expect(box.max[axis]).toBeCloseTo(max[axis], 4);
  }
}
function flow(kind: Kind): FlowDocument {
  const nodes: Array<FlowDocument['nodes'][number]> = [
    { id: 'storeys', type: 'model.byType', params: { type: 'IfcBuildingStorey' } },
    { id: 'storey', type: 'core.first' },
    { id: 'spec', type: `element.${kind}`, params: kind === 'stair'
      ? { NumberOfRisers: 4, RiserHeight: .2, TreadLength: .3, Width: 1, Name: STAIR.Name }
      : { Path: RAILING.Path, Height: 1.1, RailDiameter: .1, PostDiameter: .1, PostSpacing: 1, Name: RAILING.Name } },
    { id: 'create', type: 'model.addElement', trackingKey: `d5-${kind}` },
  ];
  const edges: Array<FlowDocument['edges'][number]> = [
    { from: ['storeys', 'entities'], to: ['storey', 'items'] },
    { from: ['storey', 'item'], to: ['spec', 'storey'] },
    { from: ['spec', 'spec'], to: ['create', 'spec'] },
  ];
  if (kind === 'stair') {
    nodes.push({ id: 'one', type: 'core.number', params: { value: 1 } },
      { id: 'two', type: 'core.number', params: { value: 2 } }, { id: 'position', type: 'geometry.point' });
    edges.push({ from: ['one', 'value'], to: ['position', 'x'] },
      { from: ['two', 'value'], to: ['position', 'y'] }, { from: ['position', 'point'], to: ['spec', 'Position'] });
  }
  return { flowVersion: 2, id: `d5-${kind}`, name: `D5 ${kind}`, capabilities: ['model.read', 'model.create'],
    inputs: [], outputs: [{ nodeId: 'create', port: 'entity', label: kind }], nodes, edges };
}
async function session(count: number) {
  const registry = new InMemoryModelRegistry();
  for (const id of ['alpha', 'beta'].slice(0, count)) registry.add(await loadIfcModel(SAMPLE, { modelId: id }));
  const target = registry.get(count === 2 ? 'beta' : 'alpha')!;
  const transport = new InProcessTransport();
  await transport.connect(createMCPServer({ registry, scope: fullScope() }));
  let request = 0;
  await transport.send({ jsonrpc: '2.0', id: ++request, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'D5 stair/railing', version: 'test' } } });
  return { registry, target, transport, async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const response = await transport.send({ jsonrpc: '2.0', id: ++request, method: 'tools/call', params: { name, arguments: args } });
    if (!response || !('result' in response)) throw new Error(`No public MCP result: ${JSON.stringify(response)}`);
    return response.result as CallToolResult;
  } };
}

describe.skipIf(!AVAILABLE)('#6232 D5 canonical stair/railing SDK and public MCP', () => {
  for (const kind of ['stair', 'railing'] as const) {
    for (const operation of ['update', 'remove'] as const) {
      it(`persistent flow ${operation}: ${kind} leaves no live orphan or dangling relationship`, async () => {
        const { registry: models, target, transport } = await session(2);
        try {
          target.bim.store.addEntity(target.id, { type: 'IfcCartesianPoint', attributes: [[7, 8, 9]] });
          const before = (await records(target.bim.export.ifc())).all;
          const peer = (await records(models.get('alpha')!.bim.export.ifc())).all;
          const host: FlowHost = { bim: target.bim, defaultModelId: target.id };
          const options = { host, registry: createStandardRegistry(), tracking: new MemoryTrackingStore(), features: headlessFeatures() };
          const original = flow(kind);
          const first = await runFlow(original, options);
          expect(first.ok, JSON.stringify(first.reports)).toBe(true);
          const firstSaved = (await records(target.bim.export.ifc())).all;
          const products = firstSaved.filter(([id, e]) => e.type === (kind === 'stair' ? 'IFCSTAIR' : 'IFCRAILING')
            && !before.some(([old]) => old === id));
          expect(products).toHaveLength(1);
          await assertProduct(target.bim, { modelId: target.id, expressId: products[0][0] }, kind);
          const next: FlowDocument = operation === 'update'
            ? { ...original, nodes: original.nodes.map(node => node.id === 'spec'
              ? { ...node, params: { ...node.params, ...(kind === 'stair' ? { Width: 1.2 } : { Height: 1.4 }) } } : node) }
            : { ...original, nodes: [], edges: [], outputs: [] };
          const second = await runFlow(next, options);
          expect(second.ok, JSON.stringify(second.reports)).toBe(true);
          const saved = (await records(target.bim.export.ifc())).all, ids = new Set(saved.map(([id]) => id));
          const authored = saved.filter(([id]) => !before.some(([old]) => old === id));
          const dangling = authored.flatMap(([id, entity]) => {
            const refs = entity.type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE' ? entity.attributes[4]
              : entity.type === 'IFCRELAGGREGATES' ? [entity.attributes[4], ...(Array.isArray(entity.attributes[5]) ? entity.attributes[5] : [])] : [];
            return Array.isArray(refs) ? refs.filter(ref => typeof ref === 'number' && !ids.has(ref)).map(ref => ({ relationship: id, target: ref })) : [];
          });
          expect({ products: authored.filter(([, e]) => e.type === (kind === 'stair' ? 'IFCSTAIR' : 'IFCRAILING')).length,
            flights: authored.filter(([, e]) => e.type === 'IFCSTAIRFLIGHT').length, dangling })
            .toEqual({ products: operation === 'update' ? 1 : 0, flights: kind === 'stair' && operation === 'update' ? 1 : 0, dangling: [] });
          expect(saved.filter(([id]) => before.some(([old]) => old === id))).toEqual(before);
          expect((await records(models.get('alpha')!.bim.export.ifc())).all).toEqual(peer);
        } finally { transport.close(); }
      });
    }
    it(`${kind}: existing canonical Bonsai builder saves real relationships and native bounds`, async () => {
      const loaded = await loadIfcModel(SAMPLE, { modelId: 'control' });
      const editor = new StoreEditor(loaded.store, loaded.backend.getOrCreateMutationView());
      const anchor = resolveSpatialAnchor(loaded.store, 42, editor.getMutationView());
      const id = kind === 'stair' ? addStairToStore(editor, anchor, STAIR).stairId : addRailingToStore(editor, anchor, RAILING).railingId;
      await assertProduct(loaded.bim, { modelId: loaded.id, expressId: id }, kind);
    });
    for (const count of [1, 2]) {
      it(`SDK/${count}: ${kind} commits the complete native IFC graph`, async () => {
        const { registry, target, transport } = await session(count);
        try {
          const peer = count === 2 ? (await records(registry.get('alpha')!.bim.export.ifc())).all : null;
          const bim = createBimContext({ backend: new HeadlessBackend(target.store, target.id) });
          await assertProduct(bim, add(bim, target.id, kind), kind);
          if (count === 2) expect((await records(registry.get('alpha')!.bim.export.ifc())).all).toEqual(peer);
        } finally { transport.close(); }
      });
      it(`public run_flow/${count}: ${kind} records one complete Undo preserving prior IFC`, async () => {
        const { registry, target, transport, call } = await session(count);
        try {
          target.bim.store.addEntity(target.id, { type: 'IfcCartesianPoint', attributes: [[7, 8, 9]] });
          const before = (await records(target.bim.export.ifc())).all;
          const peer = count === 2 ? (await records(registry.get('alpha')!.bim.export.ifc())).all : null;
          const result = await call('run_flow', { model_id: target.id, flow: flow(kind) });
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          const saved = await records(target.bim.export.ifc());
          const type = kind === 'stair' ? 'IFCSTAIR' : 'IFCRAILING';
          const created = saved.all.filter(([id, e]) => e.type === type && !before.some(([old]) => old === id));
          expect(created).toHaveLength(1);
          await assertProduct(target.bim, { modelId: target.id, expressId: created[0][0] }, kind);
          const undo = await call('mutation_undo', { model_id: target.id });
          expect(undo.isError, JSON.stringify(undo)).not.toBe(true);
          expect((await records(target.bim.export.ifc())).all).toEqual(before);
          if (count === 2) expect((await records(registry.get('alpha')!.bim.export.ifc())).all).toEqual(peer);
        } finally { transport.close(); }
      });
    }
  }
});
