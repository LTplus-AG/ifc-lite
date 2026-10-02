/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: six existing type/material methods, real CLI and MCP backends.
 * The public Bonsai sample is extended through the existing SDK factory and
 * saved/reloaded before each case, so no unsupported prerequisite hides a
 * later method. The native geometry witness is two real material slices.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IfcCreator } from '@ifc-lite/create';
import { EntityExtractor, extractMaterialsOnDemand, getSchemaRegistryForVersion, IfcParser, normalizeIfcTypeName } from '@ifc-lite/parser';
import { createBimContext, type EntityRef } from '@ifc-lite/sdk';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { createMCPServer, fullScope, InMemoryModelRegistry, InProcessTransport,
  loadIfcModel, type CallToolResult } from '@ifc-lite/mcp';
import { HeadlessBackend } from './headless-backend.js';

const SAMPLE = fileURLToPath(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
const WASM = fileURLToPath(new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const AVAILABLE = existsSync(SAMPLE) && existsSync(WASM);
if (!AVAILABLE) console.warn('skip: restore public Bonsai hello-wall.ifc and run pnpm build:wasm');
type Bim = ReturnType<typeof createBimContext>;
interface Seed { wall: number; type: number; concrete: number; wool: number; set: number; usage: number; storey: number }
interface Route { name: string; type: string; add: (bim: Bim, modelId: string, seed: Seed) => EntityRef }
const ROUTES: Route[] = [
  { name: 'addElementType', type: 'IFCWALLTYPE', add: (b, m) => b.store.addElementType(m, { Type: 'IfcWallType', Name: 'D5 replacement type', PredefinedType: 'STANDARD' }) },
  { name: 'assignType', type: 'IFCRELDEFINESBYTYPE', add: (b, m, s) => b.store.assignType(m, s.type, [s.wall]) },
  { name: 'addMaterial', type: 'IFCMATERIAL', add: (b, m) => b.store.addMaterial(m, { Name: 'D5 new material' }) },
  { name: 'addMaterialLayerSet', type: 'IFCMATERIALLAYERSET', add: (b, m, s) => b.store.addMaterialLayerSet(m, {
    LayerSetName: 'D5 new set', MaterialLayers: [{ Material: s.concrete, LayerThickness: .2 }, { Material: s.wool, LayerThickness: .1 }],
  }) },
  { name: 'addMaterialLayerSetUsage', type: 'IFCMATERIALLAYERSETUSAGE', add: (b, m, s) => b.store.addMaterialLayerSetUsage(m, { ForLayerSet: s.set, OffsetFromReferenceLine: -.15 }) },
  { name: 'assignMaterial', type: 'IFCRELASSOCIATESMATERIAL', add: (b, m, s) => b.store.assignMaterial(m, s.usage, [s.wall]) },
];
let api: IfcAPI | undefined;
let directory: string | undefined;
let filePath: string;
let seed: Seed;

async function parsed(content: string | Uint8Array) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
}
// Every export stamps its FILE_NAME timestamp. Peer/Undo checks retain exact
// DATA IDs, GUIDs, attributes and enum token kinds rather than export instants.
async function records(content: string | Uint8Array) {
  const store = await parsed(content), extractor = new EntityExtractor(store.source);
  return [...store.entityIndex.byId].map(([id, location]) => [id, extractor.extractEntity(location)] as const).sort((a, b) => a[0] - b[0]);
}

function authorSeed(bim: Bim, modelId: string, storey: number): Seed {
  const wall = bim.store.addWall(modelId, storey, { Start: [0, 3, 0], End: [5, 3, 0], Thickness: .3, Height: 3, Name: 'D5 layered wall' }).expressId;
  const originalType = bim.store.addElementType(modelId, { Type: 'IfcWallType', Name: 'D5 initial type', PredefinedType: 'STANDARD' }).expressId;
  const replacementType = bim.store.addElementType(modelId, { Type: 'IfcWallType', Name: 'D5 source replacement type', PredefinedType: 'STANDARD' }).expressId;
  bim.store.assignType(modelId, originalType, [wall]);
  const concrete = bim.store.addMaterial(modelId, { Name: 'Concrete' }).expressId;
  const wool = bim.store.addMaterial(modelId, { Name: 'Mineral wool' }).expressId;
  const set = bim.store.addMaterialLayerSet(modelId, { LayerSetName: 'D5 source set',
    MaterialLayers: [{ Material: concrete, LayerThickness: .2 }, { Material: wool, LayerThickness: .1 }] }).expressId;
  const originalUsage = bim.store.addMaterialLayerSetUsage(modelId, { ForLayerSet: set, OffsetFromReferenceLine: -.15 }).expressId;
  const replacementUsage = bim.store.addMaterialLayerSetUsage(modelId, { ForLayerSet: set, OffsetFromReferenceLine: -.15 }).expressId;
  bim.store.assignMaterial(modelId, set, [originalType]);
  bim.store.assignMaterial(modelId, originalUsage, [wall]);
  return { wall, type: replacementType, concrete, wool, set, usage: replacementUsage, storey };
}
beforeAll(async () => {
  if (!AVAILABLE) return;
  initSync({ module: readFileSync(WASM) });
  api = new IfcAPI();
  const loaded = await loadIfcModel(SAMPLE, { modelId: 'seed' });
  const bim = createBimContext({ backend: new HeadlessBackend(loaded.store, 'seed') });
  seed = authorSeed(bim, 'seed', 42);
  directory = await mkdtemp(join(tmpdir(), 'ifc-lite-d5-type-material-'));
  filePath = join(directory, 'bonsai-layered-wall.ifc');
  await writeFile(filePath, bim.export.ifc());
});
afterAll(async () => {
  try { api?.free(); }
  finally { if (directory) await rm(directory, { recursive: true, force: true }); }
});

async function assertLayeredWall(content: string | Uint8Array, fixture = seed) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const store = await parsed(bytes);
  expect(store.spatialHierarchy?.elementToStorey.get(fixture.wall)).toBe(fixture.storey);
  const materials = extractMaterialsOnDemand(store, fixture.wall);
  expect(materials?.layers?.map(layer => [layer.materialName, layer.thickness])).toEqual([['Concrete', .2], ['Mineral wool', .1]]);
  if (!api) throw new Error('Native API not initialized');
  const pre = api.buildPrePassOnce(bytes);
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  let pieces = 0, vertices = 0;
  try {
    const offset = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
    const meshes = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, offset[0], offset[1], offset[2], pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    try {
      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes.get(i);
        if (!mesh) continue;
        try {
          if (mesh.expressId !== fixture.wall) continue;
          expect(mesh.geometryClass).toBe(3); // Rust GEOM_CLASS_LAYER_SLICE.
          pieces++;
          const positions = mesh.positions, origin = mesh.origin;
          for (let j = 0; j < positions.length; j += 3) {
            const point = [origin[0] + positions[j], -(origin[2] + positions[j + 2]), origin[1] + positions[j + 1]];
            for (let axis = 0; axis < 3; axis++) {
              const value = point[axis] + (pre.needsShift ? offset[axis] : 0);
              minimum[axis] = Math.min(minimum[axis], value); maximum[axis] = Math.max(maximum[axis], value);
            }
            vertices++;
          }
        } finally { mesh.free(); }
      }
    } finally { meshes.free(); }
  } finally { api.clearPrePassCache(); }
  expect(pieces).toBe(2);
  expect(vertices).toBeGreaterThan(0);
  for (let axis = 0; axis < 3; axis++) {
    expect((minimum[axis] + maximum[axis]) / 2).toBeCloseTo([2.5, 3, 1.5][axis], 4);
    expect(maximum[axis] - minimum[axis]).toBeCloseTo([5, .3, 3][axis], 4);
  }
}

async function assertResult(content: string | Uint8Array, route: Route, ref: EntityRef, fixture = seed, native = 1) {
  const saved = new Map(await records(content)), result = saved.get(ref.expressId);
  expect(result?.type).toBe(route.type);
  if (route.name === 'addElementType') {
    expect(result?.attributes[2]).toBe('D5 replacement type');
    expect(result?.attributes[9]).toBe('.STANDARD.');
  }
  if (route.name === 'addMaterial') expect(result?.attributes[0]).toBe('D5 new material');
  if (route.name === 'assignType' || route.name === 'assignMaterial') {
    expect(result?.attributes[4]).toEqual([fixture.wall]);
    expect(result?.attributes[5]).toBe(route.name === 'assignType' ? fixture.type : fixture.usage);
    const ownerRelations = [...saved.values()].filter(entity => entity?.type === route.type && Array.isArray(entity.attributes[4]) && entity.attributes[4].includes(fixture.wall));
    expect(ownerRelations).toHaveLength(1);
  }
  if (route.name === 'addMaterialLayerSet') {
    expect(result?.attributes[1]).toBe('D5 new set');
    const layerIds = result?.attributes[0];
    if (!Array.isArray(layerIds)) throw new Error('Saved material layer set has no layers');
    expect(layerIds.map(id => {
      if (typeof id !== 'number') throw new Error('Saved material layer is not an entity reference');
      return saved.get(id)?.attributes.slice(0, 2);
    })).toEqual([[fixture.concrete, .2 * native], [fixture.wool, .1 * native]]);
  }
  if (route.name === 'addMaterialLayerSetUsage') expect(result?.attributes.slice(0, 4)).toEqual([fixture.set, '.AXIS2.', '.POSITIVE.', -.15 * native]);
  await assertLayeredWall(content, fixture);
}

describe.skipIf(!AVAILABLE)('#6232 D5 six type/material routes on real loaded models', () => {
  for (const count of [1, 2]) {
    it(`all six CLI SDK methods preserve native material slices with ${count} model(s)`, async () => {
      const contexts = [];
      for (const id of ['alpha', 'beta'].slice(0, count)) {
        const loaded = await loadIfcModel(filePath, { modelId: id });
        contexts.push({ id, bim: createBimContext({ backend: new HeadlessBackend(loaded.store, id) }) });
      }
      const target = contexts.at(-1)!, peer = count === 2 ? await records(contexts[0].bim.export.ifc()) : null;
      await assertLayeredWall(target.bim.export.ifc());
      for (const route of ROUTES) {
        const ref = route.add(target.bim, target.id, seed);
        expect(ref.modelId).toBe(target.id);
        await assertResult(target.bim.export.ifc(), route, ref);
      }
      if (count === 2) expect(await records(contexts[0].bim.export.ifc())).toEqual(peer);
    });
    for (const route of ROUTES) it(`MCP ${route.name} saves and completely undoes with ${count} model(s)`, async () => {
      const registry = new InMemoryModelRegistry();
      for (const id of ['alpha', 'beta'].slice(0, count)) registry.add(await loadIfcModel(filePath, { modelId: id }));
      const target = registry.get(count === 2 ? 'beta' : 'alpha')!, peer = count === 2 ? await records(registry.get('alpha')!.bim.export.ifc()) : null;
      const transport = new InProcessTransport();
      await transport.connect(createMCPServer({ registry, scope: fullScope() }));
      let id = 0;
      const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
        const response = await transport.send({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
        if (!response || !('result' in response)) throw new Error('Public MCP response missing');
        return response.result as CallToolResult;
      };
      try {
        await transport.send({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'D5 type/material parity', version: 'test' } } });
        expect((await call('entity_create', { model_id: target.id, type: 'IfcCartesianPoint', attributes: [[7, 8, 9]] })).isError).not.toBe(true);
        const before = await records(target.bim.export.ifc()), journal = target.backend.getMutationView()!.getMutations();
        const overlay = structuredClone(target.backend.getMutationView()!.getNewEntities());
        await assertLayeredWall(target.bim.export.ifc());
        // Actual loaded MCP backend through the existing public SDK method;
        // these six methods are currently unsupported stubs, not flow kinds.
        const ref = route.add(target.bim, target.id, seed);
        expect(ref.modelId).toBe(target.id);
        await assertResult(target.bim.export.ifc(), route, ref);
        expect((await call('mutation_undo', { model_id: target.id })).isError).not.toBe(true);
        expect(await records(target.bim.export.ifc())).toEqual(before);
        expect(target.backend.getMutationView()!.getMutations()).toEqual(journal);
        expect(target.backend.getMutationView()!.getNewEntities()).toEqual(overlay);
        await assertLayeredWall(target.bim.export.ifc());
        if (count === 2) expect(await records(registry.get('alpha')!.bim.export.ifc())).toEqual(peer);
      } finally { transport.close(); }
    });
  }
  for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) for (const millimetres of [false, true]) {
    it(`${schema}/${millimetres ? 'mm' : 'm'}: existing SDK saves six schema-correct methods and native layers`, async () => {
      if (!directory) throw new Error('Fixture directory not initialized');
      const creator = new IfcCreator({ Schema: schema, LengthUnit: millimetres ? 'MILLIMETRE' : 'METRE', Timestamp: 0 });
      const storey = creator.addIfcBuildingStorey({ Name: 'D5 generated type/material control', Elevation: 0 });
      const path = join(directory, `${schema}-${millimetres ? 'mm' : 'm'}.ifc`);
      await writeFile(path, creator.toIfc().content);
      const loaded = await loadIfcModel(path, { modelId: 'schema' });
      expect(loaded.store.schemaVersion).toBe(schema);
      const bim = createBimContext({ backend: new HeadlessBackend(loaded.store, 'schema') });
      const fixture = authorSeed(bim, 'schema', storey), native = millimetres ? 1000 : 1;
      for (const route of ROUTES) {
        const ref = route.add(bim, 'schema', fixture), content = bim.export.ifc();
        await assertResult(content, route, ref, fixture, native);
        const saved = await parsed(content), extractor = new EntityExtractor(saved.source);
        const entity = extractor.extractEntity(saved.entityIndex.byId.get(ref.expressId)!);
        // Exact declaration widths differ across the actual EXPRESS schemas.
        const expected = route.name === 'addMaterial' ? (schema === 'IFC2X3' ? 1 : 3)
          : route.name === 'addMaterialLayerSet' ? (schema === 'IFC2X3' ? 2 : 3)
            : route.name === 'addMaterialLayerSetUsage' ? (schema === 'IFC2X3' ? 4 : 5)
              : route.name === 'addElementType' ? 10 : 6;
        expect(entity?.attributes).toHaveLength(expected);
        if (schema === 'IFC2X3' && ['addElementType', 'assignType', 'assignMaterial'].includes(route.name)) {
          const owner = entity?.attributes[1];
          expect(typeof owner).toBe('number');
          expect(saved.entityIndex.byType.get('IFCOWNERHISTORY')).toContain(owner);
        }
        expect(saved.lengthUnitScale).toBe(millimetres ? .001 : 1);
      }
    });
  }
  for (const millimetres of [false, true]) {
    it(`IFC2X3/${millimetres ? 'mm' : 'm'}: late layer-set Description refusal leaves the prior authored model intact`, async () => {
      if (!directory) throw new Error('Fixture directory not initialized');
      const creator = new IfcCreator({ Schema: 'IFC2X3', LengthUnit: millimetres ? 'MILLIMETRE' : 'METRE', Timestamp: 0 });
      const storey = creator.addIfcBuildingStorey({ Name: 'D5 late layer-set refusal', Elevation: 0 });
      const path = join(directory, `IFC2X3-late-${millimetres ? 'mm' : 'm'}.ifc`);
      await writeFile(path, creator.toIfc().content);
      const loaded = await loadIfcModel(path, { modelId: 'late' });
      expect(loaded.store.schemaVersion).toBe('IFC2X3');
      const bim = createBimContext({ backend: new HeadlessBackend(loaded.store, 'late') });
      const fixture = authorSeed(bim, 'late', storey);
      await assertLayeredWall(bim.export.ifc(), fixture);
      const before = await records(bim.export.ifc());
      // The valid layer definitions precede the unsupported set-level field.
      // A refusal must not leave those orphan helpers in the live overlay.
      expect(() => bim.store.addMaterialLayerSet('late', {
        LayerSetName: 'D5 refused set', Description: 'IFC2X3 has no set Description',
        MaterialLayers: [{ Material: fixture.concrete, LayerThickness: .2 }, { Material: fixture.wool, LayerThickness: .1 }],
      })).toThrow(new Error('addMaterialLayerSetToStore: IfcMaterialLayerSet has no attribute Description in IFC2X3'));
      expect(await records(bim.export.ifc())).toEqual(before);
      await assertLayeredWall(bim.export.ifc(), fixture);
    });
  }

  for (const millimetres of [false, true]) for (const count of [1, 2]) {
    it(`IFC2X3/${millimetres ? 'mm' : 'm'}: all six MCP methods keep owner history and public Undo with ${count} model(s)`, async () => {
      if (!directory) throw new Error('Fixture directory not initialized');
      const creator = new IfcCreator({ Schema: 'IFC2X3', LengthUnit: millimetres ? 'MILLIMETRE' : 'METRE', Timestamp: 0 });
      const storey = creator.addIfcBuildingStorey({ Name: 'D5 MCP legacy-schema control', Elevation: 0 });
      const path = join(directory, `IFC2X3-mcp-${millimetres ? 'mm' : 'm'}-${count}.ifc`);
      await writeFile(path, creator.toIfc().content);
      const source = await loadIfcModel(path, { modelId: 'source' });
      const author = createBimContext({ backend: new HeadlessBackend(source.store, 'source') });
      const fixture = authorSeed(author, 'source', storey);
      await writeFile(path, author.export.ifc());
      const registry = new InMemoryModelRegistry();
      for (const modelId of ['alpha', 'beta'].slice(0, count)) registry.add(await loadIfcModel(path, { modelId }));
      const target = registry.get(count === 2 ? 'beta' : 'alpha')!;
      const peer = count === 2 ? await records(registry.get('alpha')!.bim.export.ifc()) : null;
      const sourceOwner = target.store.entityIndex.byType.get('IFCOWNERHISTORY')?.[0];
      if (sourceOwner === undefined) throw new Error('IFC2X3 control has no source owner history');
      let expectedOwner = sourceOwner;
      const transport = new InProcessTransport();
      await transport.connect(createMCPServer({ registry, scope: fullScope() }));
      let id = 0;
      const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
        const response = await transport.send({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
        if (!response || !('result' in response)) throw new Error('Public MCP response missing');
        return response.result as CallToolResult;
      };
      try {
        await transport.send({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'D5 legacy type/material parity', version: 'test' } } });
        expect((await call('entity_create', { model_id: target.id, type: 'IfcCartesianPoint', attributes: [[7, 8, 9]] })).isError).not.toBe(true);
        if (count === 2) {
          // Replace the source history through real overlay writes, then remove
          // it: six-method resolution must use the live created owner instead.
          const saved = await records(target.bim.export.ifc());
          const history = new Map(saved).get(sourceOwner);
          if (!history) throw new Error('Source owner history is not readable');
          const registry = getSchemaRegistryForVersion('IFC2X3');
          const declaration = registry.entities.IfcOwnerHistory.allAttributes;
          if (!declaration) throw new Error('IFC2X3 owner-history declaration is unavailable');
          const attributes = history.attributes.map((value, index) =>
            typeof value === 'number' && registry.entities[declaration[index].type] ? `#${value}` : value);
          expectedOwner = target.bim.store.addEntity(target.id, { type: 'IfcOwnerHistory', attributes }).expressId;
          for (const [expressId, entity] of saved) {
            if (!entity) throw new Error('Saved source entity is unreadable');
            const fields = registry.entities[normalizeIfcTypeName(entity.type)]?.allAttributes;
            const ownerSlot = fields?.findIndex(field => field.name === 'OwnerHistory') ?? -1;
            if (ownerSlot >= 0 && entity.attributes[ownerSlot] === sourceOwner) {
              target.bim.store.setPositionalAttribute({ modelId: target.id, expressId }, ownerSlot, `#${expectedOwner}`);
            }
          }
          expect((await call('entity_delete', { model_id: target.id, express_id: sourceOwner })).isError).not.toBe(true);
          expect(new Map(await records(target.bim.export.ifc())).has(sourceOwner)).toBe(false);
        }
        for (const route of ROUTES) {
          const before = await records(target.bim.export.ifc());
          const journal = target.backend.getMutationView()!.getMutations();
          const overlay = structuredClone(target.backend.getMutationView()!.getNewEntities());
          const ref = route.add(target.bim, target.id, fixture);
          const content = target.bim.export.ifc();
          await assertResult(content, route, ref, fixture, millimetres ? 1000 : 1);
          if (['addElementType', 'assignType', 'assignMaterial'].includes(route.name)) {
            expect(new Map(await records(content)).get(ref.expressId)?.attributes[1]).toBe(expectedOwner);
          }
          expect((await call('mutation_undo', { model_id: target.id })).isError).not.toBe(true);
          expect(await records(target.bim.export.ifc())).toEqual(before);
          expect(target.backend.getMutationView()!.getMutations()).toEqual(journal);
          expect(target.backend.getMutationView()!.getNewEntities()).toEqual(overlay);
          await assertLayeredWall(target.bim.export.ifc(), fixture);
          if (count === 2) expect(await records(registry.get('alpha')!.bim.export.ifc())).toEqual(peer);
        }
      } finally { transport.close(); }
    });
  }
  for (const millimetres of [false, true]) {
    it(`IFC2X3/${millimetres ? 'mm' : 'm'}: a late layer Description refusal preserves records, journal and allocator`, async () => {
      if (!directory) throw new Error('Fixture directory not initialized');
      const creator = new IfcCreator({ Schema: 'IFC2X3', LengthUnit: millimetres ? 'MILLIMETRE' : 'METRE', Timestamp: 0 });
      const storey = creator.addIfcBuildingStorey({ Name: 'D5 late layer refusal', Elevation: 0 });
      const path = join(directory, `IFC2X3-late-layer-${millimetres ? 'mm' : 'm'}.ifc`);
      await writeFile(path, creator.toIfc().content);
      const loaded = await loadIfcModel(path, { modelId: 'late-layer' });
      const backend = new HeadlessBackend(loaded.store, 'late-layer');
      const bim = createBimContext({ backend });
      const fixture = authorSeed(bim, 'late-layer', storey);
      const before = await records(bim.export.ifc());
      const view = backend.tableAccess('late-layer').mutationView;
      if (!view) throw new Error('Authored CLI mutation view is unavailable');
      const journal = view.getMutations(), nextId = view.peekNextExpressId();
      expect(() => bim.store.addMaterialLayerSet('late-layer', {
        LayerSetName: 'D5 refused layer', MaterialLayers: [
          { Material: fixture.concrete, LayerThickness: .2 },
          { Material: fixture.wool, LayerThickness: .1, Description: 'IFC2X3 has no layer Description' },
        ],
      })).toThrow(new Error('addMaterialLayerSetToStore: IfcMaterialLayer has no attribute Description in IFC2X3'));
      expect(await records(bim.export.ifc())).toEqual(before);
      expect(view.getMutations()).toEqual(journal);
      expect(view.peekNextExpressId()).toBe(nextId);
      await assertLayeredWall(bim.export.ifc(), fixture);
    });
  }
});
