/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { GeometryResult, ModelSpatialReference } from '@ifc-lite/geometry';
import { fixtureModel } from '@/test/store-fixture.js';
import { parseSpatialIfc } from '@/test/ifc-spatial-fixture.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { toast } from '@/components/ui/toast.js';
import { extractModelSpatialPlacement, findReferenceSpatialModel } from './federationAlign.js';
import { finalizeFederatedSpatialPlacement } from './federatedSpatialFinalize.js';
import { realignFederationModels } from './federationRealign.js';

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
    meshes: [{ expressId: 1, positions: new Float32Array([2, 3, 4]), normals: new Float32Array([0, 1, 0]),
      indices: new Uint32Array(), color: [1, 1, 1, 1], origin: [0, 0, 0] }],
    totalVertices: 1, totalTriangles: 0, instancedGeometryAabbs: undefined,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
      originalBounds: { min: { x: 2, y: 3, z: 4 }, max: { x: 2, y: 3, z: 4 } },
      shiftedBounds: { min: { x: 2, y: 3, z: 4 }, max: { x: 2, y: 3, z: 4 } } },
  };
}

async function model(id: string, verticalDatum?: string): Promise<FederatedModel> {
  return { ...fixtureModel(id), ifcDataStore: await parseSpatialIfc({ verticalDatum }), geometryResult: geometry() };
}

function placement(m: FederatedModel) {
  const parsed = extractModelSpatialPlacement(m.ifcDataStore!, m.geometryResult!.coordinateInfo);
  assert.ok(parsed, 'test model must have a genuine parser-backed IFC placement');
  return parsed;
}

function finalize(source: FederatedModel, spatialReference?: ModelSpatialReference) {
  return finalizeFederatedSpatialPlacement({
    dataStore: source.ifcDataStore!, geometry: source.geometryResult!, modelId: source.id,
    fileName: `${source.id}.ifc`, spatialReference, isCurrent: () => true, setProgress: () => undefined,
  });
}

describe('authored IFC vertical declarations (#8042/R58-F2)', () => {
  it('refuses unreconciled named declarations in actual parsed IFC during both load and re-alignment', async () => {
    for (const [sourceName, targetName] of [['DHHN92', 'DHHN2016'], ['DHHN2016', 'DHHN92'], ['DHHN92', 'NAVD88']]) {
      const target = await model('anchor', targetName);
      const source = await model('revision', sourceName);
      const sourceRef = placement(source).spatialReference;
      const targetRef = placement(target).spatialReference;
      assert.equal(sourceRef.vertical, undefined, 'unrecognized names must not acquire invented EPSG IDs');
      assert.equal(sourceRef.sourceMetadata?.verticalDatum, sourceName);
      assert.equal(targetRef.sourceMetadata?.verticalDatum, targetName);
      assert.deepEqual(sourceRef.localToProjected, targetRef.localToProjected);
      useViewerStore.setState({ models: new Map([[target.id, target]]), ifcSharedVerticalDatum: true });
      assert.equal(findReferenceSpatialModel()?.modelId, target.id);
      const before = structuredClone(source.geometryResult);
      const loaded = await finalize(source);
      assert.equal(loaded?.federationAlignmentStatus, 'failed');
      assert.equal(loaded?.ifcSharedVerticalDatumAssumed, undefined);
      assert.deepEqual(source.geometryResult, before);
      assert.doesNotMatch(errors.at(-1) ?? '', /datum is missing|enable the IFC/);
      const models = new Map([[target.id, target], [source.id, source]]);
      const realigned = await realignFederationModels({
        models: [...models], anchorModelId: target.id, anchorModel: target, anchorGeoref: placement(target),
        assumeIfcSharedVerticalDatum: true, resolveGeoref: (_id, m) => placement(m),
        updateModel: (id, patch) => Object.assign(models.get(id)!, patch),
      });
      assert.equal(realigned.counts.failed, 1);
      assert.equal(source.federationAlignmentStatus, 'failed');
      assert.equal(source.ifcSharedVerticalDatumAssumed, undefined);
      assert.deepEqual(source.geometryResult, before);
      assert.equal(placement(source).spatialReference.sourceMetadata?.verticalDatum, sourceName);
    }
  });

  it('requires opt-in for equal unresolved names and distinguishes them from missing declarations', async () => {
    for (const targetName of ['DHHN92', undefined]) {
      const target = await model('anchor', targetName);
      const source = await model('revision', 'DHHN92');
      useViewerStore.setState({ models: new Map([[target.id, target]]), ifcSharedVerticalDatum: false });
      assert.equal((await finalize(source))?.federationAlignmentStatus, 'failed');
      assert.match(errors.at(-1) ?? '', /declaration could not be resolved.*enable the IFC/);
      assert.doesNotMatch(errors.at(-1) ?? '', /datum is missing/);
      const before = structuredClone(source.geometryResult);
      useViewerStore.setState({ ifcSharedVerticalDatum: true });
      const loaded = await finalize(source);
      assert.equal(loaded?.federationAlignmentStatus, 'identity');
      assert.equal(loaded?.ifcSharedVerticalDatumAssumed, 'unresolved');
      assert.deepEqual(source.geometryResult, before);
      assert.equal(placement(source).spatialReference.vertical, undefined);
      assert.equal(placement(source).spatialReference.sourceMetadata?.verticalDatum, 'DHHN92');
    }
  });

  it('retains existing authoritative aliases and refuses different recognized datums', async () => {
    for (const [sourceName, targetName, status] of [
      ['NAVD88', 'EPSG:5703', 'identity'],
      ['NAP', 'NORMAAL AMSTERDAMS PEIL', 'identity'],
      ['NAVD88', 'NAP', 'failed'],
    ] as const) {
      const target = await model('anchor', targetName);
      const source = await model('revision', sourceName);
      useViewerStore.setState({ models: new Map([[target.id, target]]), ifcSharedVerticalDatum: true });
      const loaded = await finalize(source);
      assert.equal(loaded?.federationAlignmentStatus, status);
      assert.equal(loaded?.ifcSharedVerticalDatumAssumed, undefined);
      assert.equal(placement(source).spatialReference.sourceMetadata?.verticalDatum, sourceName);
    }
  });
});

describe('IFC height-system remedy relevance (#8042/R58-F3)', () => {
  it('does not recommend an enabled choice, invalid operation, or unavailable horizontal projection', async () => {
    const target = await model('anchor');
    const source = await model('revision');
    const sourceRef = placement(source).spatialReference;
    useViewerStore.setState({ models: new Map([[target.id, target]]) });
    for (const enabled of [false, true]) {
      useViewerStore.setState({ ifcSharedVerticalDatum: enabled });
      for (const invalid of [
        { ...sourceRef, localToProjected: { ...sourceRef.localToProjected!, scaleZ: 0 } },
        { ...sourceRef, localToProjected: { ...sourceRef.localToProjected!, eastings: Number.NaN } },
        { ...sourceRef, horizontal: { id: 'unknown:unresolvable' } },
      ]) {
        const before = structuredClone(source.geometryResult);
        assert.equal((await finalize(source, invalid))?.federationAlignmentStatus, 'failed');
        assert.doesNotMatch(errors.at(-1) ?? '', /enable the IFC/);
        assert.deepEqual(source.geometryResult, before);
      }
    }
  });
});
