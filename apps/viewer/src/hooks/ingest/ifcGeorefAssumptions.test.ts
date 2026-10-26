/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { localViewerToProjected, type GeometryResult, type ModelSpatialReference } from '@ifc-lite/geometry';
import { parseSpatialIfc } from '@/test/ifc-spatial-fixture.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast.js';
import { extractModelSpatialPlacement, findReferenceSpatialModel } from './federationAlign.js';
import { finalizeFederatedSpatialPlacement } from './federatedSpatialFinalize.js';
import { realignFederationModels, type RealignableModel } from './federationRealign.js';

const initialState = useViewerStore.getState();
const originalError = toast.error;
let errors: string[];
beforeEach(() => {
  useViewerStore.getState().clearAllModels();
  useViewerStore.setState({ ifcSharedVerticalDatum: false });
  errors = [];
  toast.error = (message: string) => { errors.push(message); };
});
afterEach(() => {
  toast.error = originalError;
  useViewerStore.setState(initialState, true);
});

function geometry(): GeometryResult {
  return {
    meshes: [{
      expressId: 1, positions: new Float32Array([2, 3, 4, 3, 3, 4, 2, 4, 4]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
      color: [1, 1, 1, 1], origin: [0, 0, 0],
      geometryAabb: { min: [2, 3, 4], max: [3, 4, 4] },
    }],
    totalVertices: 3, totalTriangles: 1, instancedGeometryAabbs: undefined,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
      originalBounds: { min: { x: 2, y: 3, z: 4 }, max: { x: 3, y: 4, z: 4 } },
      shiftedBounds: { min: { x: 2, y: 3, z: 4 }, max: { x: 3, y: 4, z: 4 } },
    },
  };
}

function reference(overrides: Partial<ModelSpatialReference> = {}): ModelSpatialReference {
  return {
    source: { axes: ['east', 'up', 'south'], horizontalUnitToMetres: 1, verticalUnitToMetres: 1 },
    horizontal: { id: 'EPSG:32760' },
    localToProjected: {
      kind: 'local-projected-affine', eastings: 100, northings: 200, orthogonalHeight: 10,
      xAxisAbscissa: 1, xAxisOrdinate: 0, scaleX: 1, scaleY: 1, scaleZ: 1,
    },
    confidence: 'declared', sourceMetadata: { format: 'ifc' }, ...overrides,
  };
}

async function installAnchor(spatialReference: ModelSpatialReference, dataStore?: IfcDataStore) {
  const operation = spatialReference.localToProjected!;
  const store = dataStore ?? await parseSpatialIfc({
    verticalDatum: spatialReference.vertical?.id, horizontalId: spatialReference.horizontal?.id,
    eastings: operation.eastings, northings: operation.northings, orthogonalHeight: operation.orthogonalHeight,
  });
  const anchor = { ...fixtureModel('anchor'), geometryResult: geometry(), ifcDataStore: store, spatialReference };
  useViewerStore.setState({ models: new Map([[anchor.id, anchor]]) });
  const selected = findReferenceSpatialModel();
  assert.equal(selected?.modelId, anchor.id, 'canonical selection must reach the parsed anchor (#8042/R58-F1)');
  assert.deepEqual(selected?.placement.spatialReference.localToProjected, spatialReference.localToProjected);
  assert.equal(selected?.placement.spatialReference.vertical?.id, spatialReference.vertical?.id);
  return anchor;
}

function finalize(source: ModelSpatialReference, result = geometry()) {
  return finalizeFederatedSpatialPlacement({
    dataStore: fixtureModel('source').ifcDataStore!, geometry: result,
    spatialReference: source, modelId: 'source', fileName: 'revision.ifc',
    isCurrent: () => true, setProgress: () => undefined,
  });
}

function firstVertex(result: GeometryResult): [number, number, number] {
  const mesh = result.meshes[0];
  return [0, 1, 2].map((axis) => mesh.positions[axis] + (mesh.origin?.[axis] ?? 0)) as [number, number, number];
}

async function parseDemo(name: string): Promise<IfcDataStore> {
  const bytes = await readFile(new URL(`../../../public/samples/${name}`, import.meta.url));
  return new IfcParser().parseColumnar(new Uint8Array(bytes).buffer, { disableWorkerScan: true });
}

describe('explicit IFC shared height system (#8042)', () => {
  it('places the unchanged authored demo revisions only after opt-in, without inventing a vertical CRS', async () => {
    const base = await parseDemo('building-architecture.ifc');
    const revision = await parseDemo('building-architecture-rev-b.ifc');
    const anchorPlacement = extractModelSpatialPlacement(base, geometry().coordinateInfo);
    const revisionPlacement = extractModelSpatialPlacement(revision, geometry().coordinateInfo);
    assert.ok(anchorPlacement && revisionPlacement);
    assert.equal(anchorPlacement.spatialReference.vertical, undefined);
    assert.equal(revisionPlacement.spatialReference.vertical, undefined);
    assert.equal(revisionPlacement.spatialReference.horizontal?.id, 'EPSG:32760');
    assert.equal(revisionPlacement.spatialReference.sourceMetadata?.mapUnitToMetres, 0.001);
    assert.deepEqual(revisionPlacement.spatialReference.localToProjected, anchorPlacement.spatialReference.localToProjected);
    await installAnchor(anchorPlacement.spatialReference, base);
    const result = geometry();
    const before = structuredClone(result);
    const run = () => finalizeFederatedSpatialPlacement({
      dataStore: revision, geometry: result, modelId: 'revision', fileName: 'building-architecture-rev-b.ifc',
      isCurrent: () => true, setProgress: () => undefined,
    });
    assert.equal((await run())?.federationAlignmentStatus, 'failed');
    assert.deepEqual(result, before, 'refusal leaves every geometry channel unchanged');
    assert.match(errors[0], /vertical datum is missing.*Settings/);
    errors.length = 0;
    useViewerStore.setState({ ifcSharedVerticalDatum: true });
    const placed = await run();
    assert.equal(placed?.federationAlignmentStatus, 'identity');
    assert.equal(placed?.ifcSharedVerticalDatumAssumed, true);
    assert.deepEqual(result, before, 'identical full placements leave vertices, origins, bounds and frame unchanged');
    assert.deepEqual(errors, []);
    assert.equal(extractModelSpatialPlacement(revision)?.spatialReference.vertical, undefined);
  });

  it('uses the full rotation, scale, height and RTC transform and preserves projected world coordinates', async () => {
    const target = reference();
    await installAnchor(target);
    const source = reference({
      localToProjected: {
        kind: 'local-projected-affine', eastings: 110, northings: 220, orthogonalHeight: 15,
        xAxisAbscissa: 0, xAxisOrdinate: 1, scaleX: 2, scaleY: 3, scaleZ: 4,
      },
    });
    const result = geometry();
    result.coordinateInfo.wasmRtcOffset = { x: 10, y: 20, z: 30 }; // IFC XYZ → viewer (10,30,-20).
    const expectedWorld = localViewerToProjected(source, [2, 3, 4], { x: 10, y: 30, z: -20 });
    assert.deepEqual(expectedWorld, [62, 244, 147]);
    useViewerStore.setState({ ifcSharedVerticalDatum: true });
    const placed = await finalize(source, result);
    assert.equal(placed?.federationAlignmentStatus, 'same-crs');
    assert.equal(placed?.ifcSharedVerticalDatumAssumed, true);
    assert.deepEqual(firstVertex(result), [-38, 137, -44]);
    assert.deepEqual(localViewerToProjected(target, firstVertex(result)), expectedWorld);
    assert.equal(result.coordinateInfo.wasmRtcOffset, undefined);
    assert.deepEqual(result.meshes[0].geometryAabb, { min: [-38, 137, -46], max: [-38, 141, -44] });
  });

  it('does not infer a shared datum from identical complete map operations or different offsets', async () => {
    await installAnchor(reference());
    for (const source of [reference(), reference({ localToProjected: { ...reference().localToProjected!, orthogonalHeight: 25 } })]) {
      const result = geometry();
      const before = structuredClone(result);
      assert.equal((await finalize(source, result))?.federationAlignmentStatus, 'failed');
      assert.deepEqual(result, before);
    }
  });

  it('keeps declared mismatches, missing horizontal CRS, invalid transforms and other formats fail-closed', async () => {
    useViewerStore.setState({ ifcSharedVerticalDatum: true });
    const target = reference({ vertical: { id: 'EPSG:5703' } });
    await installAnchor(target);
    const cases = [
      reference({ vertical: { id: 'EPSG:5709' } }),
      reference({ horizontal: undefined }),
      reference({ localToProjected: { ...reference().localToProjected!, scaleZ: 0 } }),
      reference({ localToProjected: { ...reference().localToProjected!, eastings: Number.NaN } }),
      reference({ horizontal: { id: 'unknown:unresolvable' } }),
      reference({ sourceMetadata: { format: 'landxml' } }),
      reference({ sourceMetadata: { format: 'las' } }),
    ];
    for (const source of cases) {
      const result = geometry();
      const before = structuredClone(result);
      const placed = await finalize(source, result);
      assert.equal(placed?.federationAlignmentStatus, 'failed');
      assert.equal(placed?.ifcSharedVerticalDatumAssumed, undefined);
      assert.deepEqual(result, before);
    }
  });

  it('records no assumption for equal declared datums, even while the setting is on', async () => {
    useViewerStore.setState({ ifcSharedVerticalDatum: true });
    const declared = reference({ vertical: { id: 'EPSG:5703' } });
    await installAnchor(declared);
    const placed = await finalize(declared);
    assert.equal(placed?.federationAlignmentStatus, 'identity');
    assert.equal(placed?.ifcSharedVerticalDatumAssumed, undefined);
  });

  it('restores all geometry after a bad later vertex with the assumption enabled', async () => {
    useViewerStore.setState({ ifcSharedVerticalDatum: true });
    await installAnchor(reference());
    const result = geometry();
    result.meshes.push({ ...structuredClone(result.meshes[0]), expressId: 2, positions: new Float32Array([Number.NaN, 0, 0]) });
    const before = structuredClone(result);
    const source = reference({ localToProjected: { ...reference().localToProjected!, eastings: 110 } });
    const placed = await finalize(source, result);
    assert.equal(placed?.federationAlignmentStatus, 'failed');
    assert.equal(placed?.ifcSharedVerticalDatumAssumed, undefined);
    assert.deepEqual(result, before, 'no partially transformed mesh, bounds or frame is published');
  });

  it('rolls back assumption provenance and geometry when a re-alignment is superseded', async () => {
    const a: RealignableModel = { geometryResult: geometry(), spatialReference: reference() };
    const b: RealignableModel = { geometryResult: geometry(), spatialReference: reference({
      localToProjected: { ...reference().localToProjected!, eastings: 110 },
    }), federationAlignmentStatus: 'failed' };
    const models = new Map([['a', a], ['b', b]]);
    const before = structuredClone(b.geometryResult);
    let current = true;
    const result = await realignFederationModels({
      models: [...models], anchorModelId: 'a', anchorModel: a,
      anchorGeoref: { spatialReference: a.spatialReference!, coordinateInfo: a.geometryResult!.coordinateInfo },
      assumeIfcSharedVerticalDatum: true,
      resolveGeoref: (_id, model) => ({ spatialReference: model.spatialReference!, coordinateInfo: model.geometryResult!.coordinateInfo }),
      isCurrent: () => current,
      updateModel: (id, patch) => {
        Object.assign(models.get(id)!, patch);
        if (id === 'b' && patch.ifcSharedVerticalDatumAssumed) current = false;
      },
    });
    assert.equal(result.stale, true);
    assert.deepEqual(result.movedModelIds, []);
    assert.deepEqual(b.geometryResult, before);
    assert.equal(b.federationAlignmentStatus, 'failed');
    assert.equal(b.ifcSharedVerticalDatumAssumed, undefined);
  });

  it('re-aligns with the current choice, clears reliance on anchor switches and restores refusal when disabled', async () => {
    const a: RealignableModel = { geometryResult: geometry(), spatialReference: reference() };
    const b: RealignableModel = { geometryResult: geometry(), spatialReference: reference({
      localToProjected: { ...reference().localToProjected!, eastings: 110 },
    }) };
    const models = new Map([['a', a], ['b', b]]);
    const resolve = (_id: string, m: RealignableModel) => ({ spatialReference: m.spatialReference!, coordinateInfo: m.geometryResult!.coordinateInfo });
    const run = (id: string, enabled: boolean, isCurrent = () => true) => realignFederationModels({
      models: [...models], anchorModelId: id, anchorModel: models.get(id)!, anchorGeoref: resolve(id, models.get(id)!),
      assumeIfcSharedVerticalDatum: enabled, resolveGeoref: resolve, isCurrent,
      updateModel: (modelId, patch) => Object.assign(models.get(modelId)!, patch),
    });
    assert.equal((await run('a', false)).counts.failed, 1);
    assert.equal((await run('a', true)).counts.aligned, 1);
    assert.deepEqual(firstVertex(b.geometryResult!), [12, 3, 4]);
    assert.equal(b.ifcSharedVerticalDatumAssumed, true);
    assert.equal((await run('b', true)).counts.aligned, 1);
    assert.equal(b.ifcSharedVerticalDatumAssumed, undefined, 'the restored anchor relies on no assumption');
    assert.equal(a.ifcSharedVerticalDatumAssumed, true);
    assert.deepEqual(firstVertex(a.geometryResult!), [-8, 3, 4]);
    assert.equal((await run('a', false)).counts.failed, 1);
    assert.equal(a.ifcSharedVerticalDatumAssumed, undefined);
    assert.equal(b.ifcSharedVerticalDatumAssumed, undefined);
    assert.deepEqual(firstVertex(a.geometryResult!), [2, 3, 4]);
    assert.deepEqual(firstVertex(b.geometryResult!), [2, 3, 4]);
  });
});
