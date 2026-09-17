/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The WIRING half of the #4897 re-base. `rtc-rebase.test.ts` proves the
 * translation maths against the pure function; nothing proved that the
 * models the viewer actually re-bases are the ones the STORE holds, or that
 * a federation whose geometry this cannot move is refused rather than half
 * moved. Both of those live here, in `federationRtcRebase.ts`.
 *
 * Every assertion below reads the LIVE store entry after the call, never the
 * object the test handed in: re-basing an object the store has replaced is
 * precisely the failure being guarded against.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';
import { ifcToViewerAxes } from '@ifc-lite/geometry/world-frame';
import { useViewerStore, type FederatedModel } from '../../store/index.js';
import { rebaseFederationOntoNewAnchor } from './federationRtcRebase.js';

/** Non-round, asymmetric-sign anchor: a round or zero one proves nothing. */
const ANCHOR = { x: 1234567.891, y: -987654.321, z: 42.75 };
const DELTA_YUP = ifcToViewerAxes(ANCHOR);

function coordInfo(over?: Partial<CoordinateInfo>): CoordinateInfo {
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
  return {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: box,
    shiftedBounds: box,
    hasLargeCoordinates: false,
    ...over,
  };
}

function mesh(positions: number[], geometryClass?: number): MeshData {
  return {
    expressId: 1,
    positions: new Float32Array(positions),
    normals: new Float32Array(positions.length),
    indices: new Uint32Array([0, 0, 0]),
    ...(geometryClass === undefined ? {} : { geometryClass }),
  } as unknown as MeshData;
}

function geometry(meshes: MeshData[], over?: Partial<GeometryResult>): GeometryResult {
  return {
    meshes,
    totalTriangles: 1,
    totalVertices: meshes.length,
    coordinateInfo: coordInfo(),
    ...over,
  } as GeometryResult;
}

function model(id: string, loadedAt: number, geometryResult: GeometryResult | null): FederatedModel {
  return {
    id,
    name: id,
    ifcDataStore: null,
    geometryResult,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt,
    fileSize: 0,
    idOffset: 0,
    maxExpressId: 0,
  } as unknown as FederatedModel;
}

function seed(entries: Array<[string, FederatedModel]>): void {
  useViewerStore.setState({ models: new Map(entries) });
}

function liveModel(id: string): FederatedModel {
  const found = useViewerStore.getState().models.get(id);
  assert.ok(found, `model ${id} missing from the store`);
  return found as FederatedModel;
}

/** The later, large-coordinate model that introduces the federation's anchor. */
function anchorModel(): FederatedModel {
  return model('B', 2, geometry([mesh([0, 0, 0])], {
    coordinateInfo: coordInfo({ wasmRtcOffset: ANCHOR }),
  }));
}

describe('rebaseFederationOntoNewAnchor - store freshness', () => {
  beforeEach(() => {
    seed([]);
  });

  it('re-bases the model the STORE holds when the entry was replaced during the load', () => {
    // A raw model, loaded first. `loadFile`'s await is unbounded, and during
    // it the store re-wraps this entry: `appendGeometryBatch` and
    // `releaseGeometryMemory` both `models.set(id, { ...model, geometryResult })`
    // with a FRESH geometryResult wrapper. Anything the caller captured
    // before the await is an orphan from that moment on.
    const originalGeometry = geometry([mesh([0, 1.5, 0])]);
    seed([['A', model('A', 1, originalGeometry)]]);
    const idsCapturedBeforeLoad = Array.from(useViewerStore.getState().models.keys());

    // ...the replacement, mid-load. Same MeshData objects, new wrappers.
    const replacement = { ...originalGeometry, meshes: originalGeometry.meshes };
    const models = new Map(useViewerStore.getState().models);
    models.set('A', { ...liveModel('A'), geometryResult: replacement });
    models.set('B', anchorModel());
    useViewerStore.setState({ models });

    rebaseFederationOntoNewAnchor(idsCapturedBeforeLoad, false, 'B');

    const live = liveModel('A').geometryResult!;
    assert.deepStrictEqual(
      live.coordinateInfo.wasmRtcOffset,
      ANCHOR,
      'the live store entry, not the pre-await capture, must carry the new anchor',
    );
    assert.ok(
      Math.abs(live.meshes[0].positions[1] - (1.5 - DELTA_YUP.y)) < 0.5,
      `live mesh must be translated by the re-base delta; got ${live.meshes[0].positions[1]}`,
    );
  });

  it('re-bases the live entry even when the replacement emptied the mesh buffers', () => {
    // `releaseGeometryMemory` (bounded mode) empties the shared buffers IN
    // PLACE and re-wraps the entry. The positions then cannot move, but the
    // frame the model claims still must: geometry is re-streamed against
    // `coordinateInfo`, so a stale one puts the re-upload in the old frame.
    const originalGeometry = geometry([mesh([0, 1.5, 0])]);
    seed([['A', model('A', 1, originalGeometry)]]);
    const idsCapturedBeforeLoad = Array.from(useViewerStore.getState().models.keys());

    for (const m of originalGeometry.meshes) m.positions = new Float32Array(0);
    const models = new Map(useViewerStore.getState().models);
    models.set('A', { ...liveModel('A'), geometryResult: { ...originalGeometry } });
    models.set('B', anchorModel());
    useViewerStore.setState({ models });

    rebaseFederationOntoNewAnchor(idsCapturedBeforeLoad, false, 'B');

    assert.deepStrictEqual(
      liveModel('A').geometryResult!.coordinateInfo.wasmRtcOffset,
      ANCHOR,
      'the live entry must carry the new anchor after a release-during-load',
    );
  });

  it('skips an id whose model was removed during the load instead of throwing', () => {
    seed([['A', model('A', 1, geometry([mesh([0, 1.5, 0])]))]]);
    const idsCapturedBeforeLoad = ['A', 'gone'];
    const models = new Map(useViewerStore.getState().models);
    models.set('B', anchorModel());
    useViewerStore.setState({ models });

    assert.doesNotThrow(() => rebaseFederationOntoNewAnchor(idsCapturedBeforeLoad, false, 'B'));
    assert.deepStrictEqual(liveModel('A').geometryResult!.coordinateInfo.wasmRtcOffset, ANCHOR);
  });
});

describe('rebaseFederationOntoNewAnchor - GPU-instanced federations', () => {
  beforeEach(() => {
    seed([]);
  });

  /** @returns everything `console.warn` saw while `run` executed. */
  function captureWarnings(run: () => void): string[] {
    const seen: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { seen.push(args.map(String).join(' ')); };
    try { run(); } finally { console.warn = original; }
    return seen;
  }

  function seedFederation(rawGeometry: GeometryResult): string[] {
    seed([
      ['A', model('A', 1, rawGeometry)],
      ['B', anchorModel()],
    ]);
    return ['A'];
  }

  const box = (): { min: [number, number, number]; max: [number, number, number] } =>
    ({ min: [0, 0, 0], max: [1, 1, 1] });

  it('refuses - visibly - a raw model carrying GPU-instanced geometry, moving nothing', () => {
    // Class 2 is the instanced TEMPLATE; the occurrences that place it live
    // in instance buffers this re-base cannot reach, so the boxes must not
    // move either - a moved box would describe geometry that is not there.
    const instancedBox = box();
    const raw = geometry([mesh([0, 1.5, 0]), mesh([0, 0, 0], 2)], {
      instancedGeometryAabbs: new Map([[7, instancedBox]]),
    });
    const ids = seedFederation(raw);

    const warnings = captureWarnings(() => rebaseFederationOntoNewAnchor(ids, false, 'B'));

    const live = liveModel('A').geometryResult!;
    assert.strictEqual(live.coordinateInfo.wasmRtcOffset, undefined, 'a refused model keeps its raw frame');
    assert.deepStrictEqual(Array.from(live.meshes[0].positions), [0, 1.5, 0], 'a refused model keeps its positions');
    assert.deepStrictEqual(live.instancedGeometryAabbs!.get(7), box(), 'a refused model keeps its instanced boxes');
    assert.ok(
      warnings.some((line) => line.includes('#4897')),
      `the refusal must be reported; console.warn saw ${JSON.stringify(warnings)}`,
    );
  });

  it('refuses on the instanced boxes alone, with no class-2 template present', () => {
    // Hashing on, no template emitted: `instancedGeometryAabbs` is then the
    // only signal that this model has instanced-only entities.
    const raw = geometry([mesh([0, 1.5, 0])], { instancedGeometryAabbs: new Map([[7, box()]]) });
    const ids = seedFederation(raw);

    rebaseFederationOntoNewAnchor(ids, false, 'B');

    assert.deepStrictEqual(Array.from(liveModel('A').geometryResult!.meshes[0].positions), [0, 1.5, 0]);
  });

  it('refuses on a class-2 template alone, with geometry hashing off', () => {
    // Hashing off: no `instancedGeometryAabbs` at all, so the template class
    // is the only signal. Same fixture as the positive control below apart
    // from that one mesh - if the class check went away this would move.
    const raw = geometry([mesh([0, 1.5, 0]), mesh([0, 0, 0], 2)]);
    const ids = seedFederation(raw);

    rebaseFederationOntoNewAnchor(ids, false, 'B');

    assert.deepStrictEqual(Array.from(liveModel('A').geometryResult!.meshes[0].positions), [0, 1.5, 0]);
  });

  it('positive control: the same federation without instanced geometry IS re-based', () => {
    const raw = geometry([mesh([0, 1.5, 0])]);
    const ids = seedFederation(raw);

    const warnings = captureWarnings(() => rebaseFederationOntoNewAnchor(ids, false, 'B'));

    const live = liveModel('A').geometryResult!;
    assert.deepStrictEqual(live.coordinateInfo.wasmRtcOffset, ANCHOR);
    assert.ok(
      Math.abs(live.meshes[0].positions[1] - (1.5 - DELTA_YUP.y)) < 0.5,
      `an un-refused model must move; got ${live.meshes[0].positions[1]}`,
    );
    assert.deepStrictEqual(warnings, [], 'nothing was refused, so nothing should be reported');
  });

  it('says nothing when the just-loaded model introduced no anchor at all', () => {
    // No anchor means there is nothing to re-base ONTO: an ordinary no-op,
    // not a refusal, so an instanced federation must not be told otherwise.
    const raw = geometry([mesh([0, 1.5, 0]), mesh([0, 0, 0], 2)]);
    seed([
      ['A', model('A', 1, raw)],
      ['B', model('B', 2, geometry([mesh([0, 0, 0])]))],
    ]);

    const warnings = captureWarnings(() => rebaseFederationOntoNewAnchor(['A'], false, 'B'));

    assert.deepStrictEqual(warnings, [], 'a plain no-op must not be reported as a refusal');
  });

  it('an empty instanced-box map is not instanced geometry and does not block the re-base', () => {
    const raw = geometry([mesh([0, 1.5, 0])], { instancedGeometryAabbs: new Map() });
    const ids = seedFederation(raw);

    rebaseFederationOntoNewAnchor(ids, false, 'B');

    assert.deepStrictEqual(liveModel('A').geometryResult!.coordinateInfo.wasmRtcOffset, ANCHOR);
  });
});
