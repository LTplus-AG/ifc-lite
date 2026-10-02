/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: public typing and actual section/heading forwarding are separate
 * contracts. Baseline root typecheck must expose the missing public parameters;
 * the real native controls determine whether forwarding already works. */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IfcCreator, type ProfiledBeamInStoreParams, type ProfiledColumnInStoreParams,
  type ProfiledMemberInStoreParams } from '@ifc-lite/create';
import { EntityExtractor, getSchemaRegistryForVersion, IfcParser } from '@ifc-lite/parser';
import { createBimContext, type EntityRef } from '@ifc-lite/sdk';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { createMCPServer, fullScope, InMemoryModelRegistry, InProcessTransport,
  loadIfcModel, type CallToolResult } from '@ifc-lite/mcp';
import { HeadlessBackend } from './headless-backend.js';

type Bim = ReturnType<typeof createBimContext>;
type Schema = 'IFC2X3' | 'IFC4' | 'IFC4X3';
type Vec3 = [number, number, number];
interface Route {
  name: string; product: string; profile: string; dimensions: Record<string, number>;
  localMin: Vec3; localMax: Vec3;
  add: (bim: Bim, model: string, storey: number) => EntityRef;
}
const ROUTES: Route[] = [
  {
    name: 'I column', product: 'IfcColumn', profile: 'IfcIShapeProfileDef',
    dimensions: { OverallWidth: .4, OverallDepth: .6, WebThickness: .05, FlangeThickness: .07 },
    localMin: [.7, 1.8, 0], localMax: [1.3, 2.2, 3],
    add: (bim, model, storey) => {
      const params: ProfiledColumnInStoreParams = { Position: [1, 2, 0], Height: 3,
        RefDirection: [0, 1, 0], Profile: { Type: 'I', OverallWidth: .4, OverallDepth: .6, WebThickness: .05, FlangeThickness: .07 } };
      return bim.store.addColumn(model, storey, params);
    },
  },
  {
    name: 'hollow beam', product: 'IfcBeam', profile: 'IfcRectangleHollowProfileDef',
    dimensions: { XDim: .4, YDim: .6, WallThickness: .05 },
    localMin: [0, -.2, 2.7], localMax: [4, .2, 3.3],
    add: (bim, model, storey) => {
      const params: ProfiledBeamInStoreParams = { Start: [0, 0, 3], End: [4, 0, 3],
        Profile: { Type: 'RectangleHollow', XDim: .4, YDim: .6, WallThickness: .05 } };
      return bim.store.addBeam(model, storey, params);
    },
  },
  {
    name: 'circle member', product: 'IfcMember', profile: 'IfcCircleProfileDef', dimensions: { Radius: .2 },
    localMin: [0, 1.8, 2.8], localMax: [4, 2.2, 3.2],
    add: (bim, model, storey) => {
      const params: ProfiledMemberInStoreParams = { Start: [0, 2, 3], End: [4, 2, 3],
        Profile: { Type: 'Circle', Radius: .2 } };
      return bim.store.addMember(model, storey, params);
    },
  },
  {
    name: 'turned rectangle column', product: 'IfcColumn', profile: 'IfcRectangleProfileDef',
    dimensions: { XDim: .2, YDim: .6 }, localMin: [.7, 1.9, 0], localMax: [1.3, 2.1, 3],
    add: (bim, model, storey) => bim.store.addColumn(model, storey, {
      Position: [1, 2, 0], Width: .2, Depth: .6, Height: 3, RefDirection: [0, 1, 0],
    }),
  },
];
const SAMPLE = fileURLToPath(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
const WASM = fileURLToPath(new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const AVAILABLE = existsSync(SAMPLE) && existsSync(WASM);
if (!AVAILABLE) console.warn('skip: restore the committed public Bonsai hello-wall.ifc and run pnpm build:wasm');
let api: IfcAPI | undefined;
let directory: string | undefined;
beforeAll(async () => {
  if (!AVAILABLE) return;
  initSync({ module: readFileSync(WASM) });
  api = new IfcAPI();
  directory = await mkdtemp(join(tmpdir(), 'ifc-lite-d5-profile-heading-'));
});
afterAll(async () => {
  try { api?.free(); }
  finally { if (directory) await rm(directory, { recursive: true, force: true }); }
});
async function parsed(content: string | Uint8Array) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  const extractor = new EntityExtractor(store.source);
  const records = [...store.entityIndex.byId].map(([id, location]) => [id, extractor.extractEntity(location)] as const).sort((a, b) => a[0] - b[0]);
  return { bytes, store, records };
}
function schema(value: string): Schema {
  if (value === 'IFC2X3' || value === 'IFC4' || value === 'IFC4X3') return value;
  throw new Error(`Unexpected fixture schema ${value}`);
}
function reference(value: unknown): number {
  if (typeof value !== 'number') throw new Error('Expected a saved IFC reference');
  return value;
}
function referenceList(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error('Expected saved IFC reference list');
  return value.map(reference);
}
function priorFrame(bim: Bim, model: string, storey: number, native: number) {
  const add = (type: string, attributes: unknown[]) => bim.store.addEntity(model, { type, attributes }).expressId;
  const origin = add('IfcCartesianPoint', [[10 * native, 20 * native, 2 * native]]);
  const z = add('IfcDirection', [[0, 0, 1]]), x = add('IfcDirection', [[0, 1, 0]]);
  const axis = add('IfcAxis2Placement3D', [`#${origin}`, `#${z}`, `#${x}`]);
  const placement = add('IfcLocalPlacement', [null, `#${axis}`]);
  // ObjectPlacement is the sixth inherited attribute in all three schemas.
  bim.store.setPositionalAttribute({ modelId: model, expressId: storey }, 5, `#${placement}`);
  add('IfcCartesianPoint', [[7, 8, 9]]);
}
async function assertProduct(content: string | Uint8Array, ref: EntityRef, route: Route, storey: number, native: number) {
  const { bytes, store, records } = await parsed(content), saved = new Map(records);
  const registry = getSchemaRegistryForVersion(schema(store.schemaVersion));
  const field = (id: number, type: string, name: string): unknown => {
    const entity = saved.get(id), attributes = registry.entities[type]?.allAttributes;
    expect(entity?.type).toBe(type.toUpperCase());
    const slot = attributes?.findIndex(attribute => attribute.name === name) ?? -1;
    if (slot < 0) throw new Error(`Missing declared ${type}.${name}`);
    return entity?.attributes[slot];
  };
  expect(store.lengthUnitScale).toBe(1 / native);
  expect(store.spatialHierarchy?.elementToStorey.get(ref.expressId)).toBe(storey);
  const definition = reference(field(ref.expressId, route.product, 'Representation'));
  const shapes = referenceList(field(definition, 'IfcProductDefinitionShape', 'Representations'));
  const body = shapes.find(id => field(id, 'IfcShapeRepresentation', 'RepresentationIdentifier') === 'Body');
  if (body === undefined) throw new Error('Saved product has no Body');
  const items = referenceList(field(body, 'IfcShapeRepresentation', 'Items'));
  expect(items).toHaveLength(1);
  const profile = reference(field(items[0], 'IfcExtrudedAreaSolid', 'SweptArea'));
  expect(field(profile, route.profile, 'ProfileType')).toBe('.AREA.');
  for (const [name, value] of Object.entries(route.dimensions)) expect(field(profile, route.profile, name)).toBeCloseTo(value * native, 8);
  if (!api) throw new Error('Native API not initialized');
  const pre = api.buildPrePassOnce(bytes), minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  let vertices = 0;
  try {
    const offset = pre.rtcOffset ? Array.from(pre.rtcOffset) : [0, 0, 0];
    const meshes = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, offset[0], offset[1], offset[2], pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    try {
      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes.get(i);
        if (!mesh) continue;
        try {
          if (mesh.expressId !== ref.expressId) continue;
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
  expect(vertices).toBeGreaterThan(0);
  // Independently known +90-degree storey: (x,y,z) -> (10-y,20+x,2+z).
  const expectedMin = [10 - route.localMax[1], 20 + route.localMin[0], 2 + route.localMin[2]];
  const expectedMax = [10 - route.localMin[1], 20 + route.localMax[0], 2 + route.localMax[2]];
  for (let axis = 0; axis < 3; axis++) {
    expect(minimum[axis]).toBeCloseTo(expectedMin[axis], 4);
    expect(maximum[axis]).toBeCloseTo(expectedMax[axis], 4);
  }
}
async function scenario(path: string, storey: number, native: number, backend: 'SDK' | 'MCP', count: number, route: Route) {
  const registry = new InMemoryModelRegistry();
  for (const id of ['alpha', 'beta'].slice(0, count)) registry.add(await loadIfcModel(path, { modelId: id }));
  const target = registry.get(count === 2 ? 'beta' : 'alpha')!;
  const bim = backend === 'SDK' ? createBimContext({ backend: new HeadlessBackend(target.store, target.id) }) : target.bim;
  const peer = count === 2 ? (await parsed(registry.get('alpha')!.bim.export.ifc())).records : null;
  priorFrame(bim, target.id, storey, native);
  const before = await parsed(bim.export.ifc());
  const transport = new InProcessTransport();
  await transport.connect(createMCPServer({ registry, scope: fullScope() }));
  try {
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'D5 profile test', version: 'test' } } });
    const ref = route.add(bim, target.id, storey);
    expect(ref.modelId).toBe(target.id);
    await assertProduct(bim.export.ifc(), ref, route, storey, native);
    if (backend === 'MCP') {
      const response = await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mutation_undo', arguments: { model_id: target.id } } });
      if (!response || !('result' in response)) throw new Error('Public Undo response missing');
      expect((response.result as CallToolResult).isError).not.toBe(true);
      expect((await parsed(bim.export.ifc())).records).toEqual(before.records);
    }
    if (count === 2) expect((await parsed(registry.get('alpha')!.bim.export.ifc())).records).toEqual(peer);
  } finally { transport.close(); }
}
describe.skipIf(!AVAILABLE)('#6232 typed profiles and heading', () => {
  for (const backend of ['SDK', 'MCP'] as const) for (const count of [1, 2]) for (const route of ROUTES) {
    it(`${backend}/${count} Bonsai model(s): ${route.name} saves the declared section and native world frame`, async () => {
      await scenario(SAMPLE, 42, 1, backend, count, route);
    });
  }
  for (const version of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) for (const millimetres of [false, true]) {
    it(`${version}/${millimetres ? 'mm' : 'm'}: public MCP keeps the authored profiles and heading`, async () => {
      if (!directory) throw new Error('Fixture directory missing');
      const creator = new IfcCreator({ Schema: version, LengthUnit: millimetres ? 'MILLIMETRE' : 'METRE', Timestamp: 0 });
      const storey = creator.addIfcBuildingStorey({ Name: 'D5 section control', Elevation: 0 });
      const path = join(directory, `${version}-${millimetres ? 'mm' : 'm'}.ifc`);
      await writeFile(path, creator.toIfc().content);
      for (const route of ROUTES) await scenario(path, storey, millimetres ? 1000 : 1, 'MCP', 1, route);
    });
  }
  for (const count of [1, 2]) {
    it(`MCP/${count} Bonsai model(s): invalid section keeps the earlier graph, journal and allocator`, async () => {
      const registry = new InMemoryModelRegistry();
      for (const id of ['alpha', 'beta'].slice(0, count)) registry.add(await loadIfcModel(SAMPLE, { modelId: id }));
      const target = registry.get(count === 2 ? 'beta' : 'alpha')!;
      priorFrame(target.bim, target.id, 42, 1);
      const before = await parsed(target.bim.export.ifc()), view = target.backend.getMutationView()!;
      const journal = view.getMutations(), overlay = structuredClone(view.getNewEntities()), next = view.peekNextExpressId();
      const peer = count === 2 ? (await parsed(registry.get('alpha')!.bim.export.ifc())).records : null;
      const invalid: ProfiledColumnInStoreParams = { Position: [1, 2, 0], Height: 3,
        Profile: { Type: 'I', OverallWidth: .4, OverallDepth: .6, WebThickness: .5, FlangeThickness: .07 } };
      expect(() => target.bim.store.addColumn(target.id, 42, invalid)).toThrow(new Error('addColumnToStore: IfcIShapeProfileDef WebThickness must be less than OverallWidth'));
      expect((await parsed(target.bim.export.ifc())).records).toEqual(before.records);
      expect(view.getMutations()).toEqual(journal);
      expect(view.getNewEntities()).toEqual(overlay);
      expect(view.peekNextExpressId()).toBe(next);
      if (count === 2) expect((await parsed(registry.get('alpha')!.bim.export.ifc())).records).toEqual(peer);
    });
  }
});
