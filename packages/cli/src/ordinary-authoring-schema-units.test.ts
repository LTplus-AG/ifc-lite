/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5 generated controls, separate from the real Bonsai baseline.
 * The file itself declares its schema, units and rotated/translated storey.
 * SDK and public MCP commits are witnessed by saved records and native bounds.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IfcCreator } from '@ifc-lite/create';
import { findEntity } from '@ifc-lite/data';
import { EntityExtractor, IfcParser } from '@ifc-lite/parser';
import { createBimContext } from '@ifc-lite/sdk';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import {
  createMCPServer, fullScope, InMemoryModelRegistry, InProcessTransport,
  loadIfcModel, type CallToolResult,
} from '@ifc-lite/mcp';
import type { FlowDocument } from '@ifc-lite/flow';
import { HeadlessBackend } from './headless-backend.js';

type Schema = 'IFC2X3' | 'IFC4' | 'IFC4X3';
type Vec3 = [number, number, number];
interface Bounds { min: number[]; max: number[]; vertices: number }
// buildingSMART IFC2X3, IFC4 and IFC4X3 share this slab declaration order.
const SLAB_ATTRIBUTES = ['GlobalId', 'OwnerHistory', 'Name', 'Description', 'ObjectType',
  'ObjectPlacement', 'Representation', 'Tag', 'PredefinedType'];
const WASM = fileURLToPath(new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const AVAILABLE = existsSync(WASM);
if (!AVAILABLE) console.warn('skip: native schema/unit controls need pnpm build:wasm');
let api: IfcAPI | undefined;
const fixtureDirectories: string[] = [];
beforeAll(() => {
  if (!AVAILABLE) return;
  initSync({ module: new Uint8Array(readFileSync(WASM)) });
  api = new IfcAPI();
});
afterAll(async () => {
  try { api?.free(); }
  finally { await Promise.all(fixtureDirectories.map(path => rm(path, { recursive: true, force: true }))); }
});

async function fixture(schema: Schema, millimetres: boolean) {
  const native = millimetres ? 1000 : 1;
  const creator = new IfcCreator({ Schema: schema, LengthUnit: millimetres ? 'MILLIMETRE' : 'METRE', Timestamp: 0, Name: 'D5 generated unit/frame control' });
  const storey = creator.addIfcBuildingStorey({ Name: 'D5 floor', Elevation: 2 * native });
  const frame = creator.addLocalPlacement(creator.getWorldPlacementId(), {
    Location: [10 * native, 20 * native, 2 * native], Axis: [0, 0, 1], RefDirection: [0, 1, 0],
  });
  // IfcCreator's storey convenience API has no horizontal placement option.
  // Author its ObjectPlacement in STEP before any loader reads the fixture.
  let replacements = 0;
  const source = creator.toIfc().content.replace(new RegExp(`(#${storey}=\\s*IFCBUILDINGSTOREY\\()([^;]+)(\\);)`), (_row, start: string, attributes: string, end: string) => {
    const slots = attributes.split(',');
    slots[5] = `#${frame}`;
    replacements++;
    return `${start}${slots.join(',')}${end}`;
  });
  expect(replacements, 'one actual source storey ObjectPlacement was authored').toBe(1);
  const bytes = new TextEncoder().encode(source);
  const directory = await mkdtemp(join(tmpdir(), 'ifc-lite-d5-ordinary-'));
  fixtureDirectories.push(directory);
  const filePath = join(directory, `${schema}-${millimetres ? 'mm' : 'm'}.ifc`);
  await writeFile(filePath, bytes);
  return { bytes, storey, frame, filePath };
}

function bytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
}

async function parsed(content: string | Uint8Array) {
  const buffer = bytes(content);
  return new IfcParser().parseColumnar(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer, { disableWorkerScan: true });
}

async function records(content: string | Uint8Array) {
  const store = await parsed(content), extractor = new EntityExtractor(store.source);
  return [...store.entityIndex.byId].map(([id, location]) => [id, extractor.extractEntity(location)]);
}

function physicalBounds(content: string | Uint8Array, ids: number[]) {
  if (!api) throw new Error('Native API was not initialized');
  const buffer = bytes(content), pre = api.buildPrePassOnce(buffer);
  const bounds = new Map<number, Bounds>(ids.map(id => [id, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], vertices: 0 }]));
  try {
    const offset = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
    const collection = api.processGeometryBatch(buffer, pre.jobs, pre.unitScale, offset[0], offset[1], offset[2], pre.needsShift, pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    try {
      for (let i = 0; i < collection.length; i++) {
        const mesh = collection.get(i);
        if (!mesh) continue;
        try {
          const bound = bounds.get(mesh.expressId);
          if (!bound) continue;
          const positions = mesh.positions, origin = mesh.origin;
          for (let j = 0; j < positions.length; j += 3) {
            const point = [origin[0] + positions[j], -(origin[2] + positions[j + 2]), origin[1] + positions[j + 1]];
            for (let axis = 0; axis < 3; axis++) {
              const value = point[axis] + (pre.needsShift ? offset[axis] : 0);
              bound.min[axis] = Math.min(bound.min[axis], value);
              bound.max[axis] = Math.max(bound.max[axis], value);
            }
            bound.vertices++;
          }
        } finally { mesh.free(); }
      }
    } finally { collection.free(); }
  } finally { api.clearPrePassCache(); }
  return bounds;
}

function assertBounds(bound: Bounds, centre: Vec3, size: Vec3) {
  expect(bound.vertices).toBeGreaterThan(0);
  for (let axis = 0; axis < 3; axis++) {
    expect((bound.min[axis] + bound.max[axis]) / 2).toBeCloseTo(centre[axis], 4);
    expect(bound.max[axis] - bound.min[axis]).toBeCloseTo(size[axis], 4);
  }
}

const WALL = { Start: [0, 5, 0] as Vec3, End: [4, 5, 0] as Vec3, Thickness: .2, Height: 3 };

function wallFlow(): FlowDocument {
  return {
    flowVersion: 2, id: 'd5-frame-wall', name: 'D5 frame wall', capabilities: ['model.read', 'model.create'], inputs: [], outputs: [],
    nodes: [
      { id: 'storeys', type: 'model.byType', params: { type: 'IfcBuildingStorey' } }, { id: 'storey', type: 'core.first' },
      { id: 'zero', type: 'core.number', params: { value: 0 } }, { id: 'four', type: 'core.number', params: { value: 4 } }, { id: 'five', type: 'core.number', params: { value: 5 } },
      { id: 'start', type: 'geometry.point' }, { id: 'end', type: 'geometry.point' },
      { id: 'spec', type: 'element.wall', params: { thickness: .2, height: 3 } }, { id: 'create', type: 'model.addElement' },
    ],
    edges: [
      { from: ['storeys', 'entities'], to: ['storey', 'items'] }, { from: ['storey', 'item'], to: ['spec', 'storey'] },
      { from: ['zero', 'value'], to: ['start', 'x'] }, { from: ['five', 'value'], to: ['start', 'y'] },
      { from: ['four', 'value'], to: ['end', 'x'] }, { from: ['five', 'value'], to: ['end', 'y'] },
      { from: ['start', 'point'], to: ['spec', 'start'] }, { from: ['end', 'point'], to: ['spec', 'end'] }, { from: ['spec', 'spec'], to: ['create', 'spec'] },
    ],
  };
}

describe.skipIf(!AVAILABLE)('#6232 D5 source-native schema/unit/frame controls', () => {
  for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) for (const millimetres of [false, true]) {
    const label = `${schema}/${millimetres ? 'mm' : 'm'}`;
    it(`${label}: public CLI SDK saves four physical primitives and atomically refuses a late invalid GUID`, async () => {
      const f = await fixture(schema, millimetres), loaded = await loadIfcModel(f.filePath, { modelId: 'control' });
      expect(loaded.store.schemaVersion).toBe(schema);
      const bim = createBimContext({ backend: new HeadlessBackend(loaded.store, 'control') });
      const refs = [
        bim.store.addWall('control', f.storey, WALL),
        bim.store.addColumn('control', f.storey, { Position: [1, 2, 0], Width: .3, Depth: .4, Height: 3 }),
        bim.store.addSlab('control', f.storey, { Position: [1, 2, 0], Width: 4, Depth: 3, Thickness: .2,
          Name: 'D5 slab', Description: 'D5 slab description', ObjectType: 'D5 slab object', Tag: 'D5 slab tag' }),
        bim.store.addBeam('control', f.storey, { Start: [0, 0, 3], End: [4, 0, 3], Width: .2, Height: .4 }),
      ];
      const saved = bim.export.ifc(), store = await parsed(saved), extractor = new EntityExtractor(store.source);
      expect(store.schemaVersion).toBe(schema);
      const projectIds = store.entityIndex.byType.get('IFCPROJECT') ?? [];
      expect(projectIds).toHaveLength(1);
      const project = extractor.extractEntity(store.entityIndex.byId.get(projectIds[0])!);
      const assignmentId = project?.attributes[8]; // IfcProject.UnitsInContext
      if (typeof assignmentId !== 'number') throw new Error('The saved project has no UnitsInContext reference');
      const assignment = extractor.extractEntity(store.entityIndex.byId.get(assignmentId)!);
      expect(assignment?.type).toBe('IFCUNITASSIGNMENT');
      const units = assignment?.attributes[0]; // IfcUnitAssignment.Units
      if (!Array.isArray(units)) throw new Error('The saved project unit assignment has no Units list');
      const lengthUnits = units.map(id => {
        if (typeof id !== 'number') throw new Error('An assigned unit is not an entity reference');
        return extractor.extractEntity(store.entityIndex.byId.get(id)!);
      })
        .filter(entity => entity?.attributes[1] === '.LENGTHUNIT.');
      expect(lengthUnits).toHaveLength(1);
      expect(lengthUnits[0]?.attributes.slice(2)).toEqual([millimetres ? '.MILLI.' : null, '.METRE.']);
      expect((await findEntity(schema, 'IfcSlab'))?.attributes).toEqual(SLAB_ATTRIBUTES);
      for (const [index, ref] of refs.entries()) {
        expect(ref.modelId).toBe('control');
        const product = extractor.extractEntity(store.entityIndex.byId.get(ref.expressId)!);
        expect(product?.type).toBe(['IFCWALL', 'IFCCOLUMN', 'IFCSLAB', 'IFCBEAM'][index]);
        // IFC2X3 slabs already have optional PredefinedType; wall/column/beam
        // acquire that occurrence attribute in IFC4. Official slab EXPRESS:
        // https://standards.buildingsmart.org/IFC/RELEASE/IFC2x3/TC1/HTML/ifcsharedbldgelements/lexical/ifcslab.htm
        expect(product?.attributes).toHaveLength(schema === 'IFC2X3' && index !== 2 ? 8 : 9);
        if (index === 2) {
          const named = Object.fromEntries(SLAB_ATTRIBUTES.map((name, slot) => [name, product?.attributes[slot]]));
          expect(named.GlobalId).toMatch(/^[0-3][0-9A-Za-z_$]{21}$/);
          expect(named).toMatchObject({ Name: 'D5 slab', Description: 'D5 slab description',
            ObjectType: 'D5 slab object', Tag: 'D5 slab tag', PredefinedType: '.FLOOR.' });
          const representation = named.Representation;
          if (typeof representation !== 'number') throw new Error('The saved slab has no Representation reference');
          expect(extractor.extractEntity(store.entityIndex.byId.get(representation)!)?.type).toBe('IFCPRODUCTDEFINITIONSHAPE');
        }
        expect(product?.attributes[1], 'the creator file has actual mandatory owner history').toEqual(expect.any(Number));
        expect(extractor.extractEntity(store.entityIndex.byId.get(product!.attributes[1] as number)!)?.type).toBe('IFCOWNERHISTORY');
        expect(store.spatialHierarchy?.elementToStorey.get(ref.expressId)).toBe(f.storey);
        expect(extractor.extractEntity(store.entityIndex.byId.get(product!.attributes[5] as number)!)?.attributes[0]).toBe(f.frame);
      }
      const bounds = physicalBounds(saved, refs.map(ref => ref.expressId));
      // Independent +90-degree rotation: (x,y,z) -> (10-y,20+x,2+z).
      assertBounds(bounds.get(refs[0].expressId)!, [5, 22, 3.5], [.2, 4, 3]);
      assertBounds(bounds.get(refs[1].expressId)!, [8, 21, 3.5], [.4, .3, 3]);
      assertBounds(bounds.get(refs[2].expressId)!, [6.5, 23, 2.1], [3, 4, .2]);
      assertBounds(bounds.get(refs[3].expressId)!, [10, 22, 5], [.2, 4, .4]);
      const before = await records(saved);
      expect(() => bim.store.addWall('control', f.storey, { ...WALL, GlobalId: 'invalid' })).toThrow(/valid 22-character IFC GUID/);
      expect(await records(bim.export.ifc()), 'all existing authored records survive late refusal with no leaked helpers').toEqual(before);
    });

    it(`${label}: public MCP run_flow produces the same transformed wall and one complete undo`, async () => {
      const f = await fixture(schema, millimetres), target = await loadIfcModel(f.filePath, { modelId: 'control' });
      const registry = new InMemoryModelRegistry();
      registry.add(target);
      const transport = new InProcessTransport();
      await transport.connect(createMCPServer({ registry, scope: fullScope() }));
      let requestId = 0;
      const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
        const response = await transport.send({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name, arguments: args } });
        if (!response || !('result' in response)) throw new Error(`No MCP result: ${JSON.stringify(response)}`);
        return response.result as CallToolResult;
      };
      try {
        await transport.send({ jsonrpc: '2.0', id: ++requestId, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'D5 generated controls', version: 'test' } } });
        const prior = await call('entity_create', { model_id: 'control', type: 'IfcCartesianPoint', attributes: [[7, 8, 9]] });
        expect(prior.isError).not.toBe(true);
        const before = await records(target.bim.export.ifc()), journal = target.backend.getMutationView()!.getMutations();
        const result = await call('run_flow', { model_id: 'control', flow: wallFlow() });
        expect(result.structuredContent?.ok, JSON.stringify(result.structuredContent?.errors)).toBe(true);
        const walls = target.backend.getMutationView()!.getNewEntities().filter(entity => entity.type === 'IfcWall');
        expect(walls).toHaveLength(1);
        assertBounds(physicalBounds(target.bim.export.ifc(), [walls[0].expressId]).get(walls[0].expressId)!, [5, 22, 3.5], [.2, 4, 3]);
        expect((await call('mutation_undo', { model_id: 'control' })).isError).not.toBe(true);
        expect(await records(target.bim.export.ifc()), 'one undo removes the entire wall graph, retaining the earlier point').toEqual(before);
        expect(target.backend.getMutationView()!.getMutations()).toEqual(journal);
      } finally { transport.close(); }
    });
  }
});
