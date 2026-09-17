/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The WIRING half of the #4897 convergence. `rtc-rebase.test.ts` proves the
 * translation against the pure function; this proves the viewer converges the
 * models the STORE holds when a load settles, whatever loads overlapped and in
 * whichever order they finished.
 *
 * Every assertion reads the LIVE store entry after the call.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';
import { federationFrameInfo, ifcToViewerAxes } from '@ifc-lite/geometry/world-frame';
import { useViewerStore, type FederatedModel } from '../../store/index.js';
import { convergeFederationRtcFrame } from './federationRtcRebase.js';

/** Non-round, asymmetric-sign anchor: a round or zero one proves nothing. */
const ANCHOR = { x: 1234567.891, y: -987654.321, z: 42.75 };
const DELTA_YUP = ifcToViewerAxes(ANCHOR);

type LoadState = FederatedModel['loadState'];

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

function mesh(origin: [number, number, number], geometryClass?: number): MeshData {
  return {
    expressId: 1,
    positions: new Float32Array([0, 0, 0, 0.001, 0, 0]),
    normals: new Float32Array(6),
    indices: new Uint32Array([0, 1, 0]),
    origin,
    ...(geometryClass === undefined ? {} : { geometryClass }),
  } as unknown as MeshData;
}

function geometry(meshes: MeshData[], over?: Partial<GeometryResult>): GeometryResult {
  return {
    meshes,
    totalTriangles: 1,
    totalVertices: meshes.length * 2,
    coordinateInfo: coordInfo(),
    ...over,
  } as GeometryResult;
}

function model(id: string, loadedAt: number, geometryResult: GeometryResult | null, loadState: LoadState = 'complete'): FederatedModel {
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
    loadState,
  } as unknown as FederatedModel;
}

/** A near-origin model: meshed raw, element origin at (2, 1, -3). */
const rawModel = (loadedAt: number, loadState?: LoadState) => model('A', loadedAt, geometry([mesh([2, 1, -3])]), loadState);
/** A large-coordinate model: meshed against ANCHOR, element origin near 0. */
const anchoredModel = (loadedAt: number, loadState?: LoadState) =>
  model('B', loadedAt, geometry([mesh([4, 0.5, -1])], { coordinateInfo: coordInfo({ wasmRtcOffset: { ...ANCHOR } }) }), loadState);

function seed(entries: FederatedModel[]): void {
  useViewerStore.setState({ models: new Map(entries.map((m) => [m.id, m])) });
}

function setLoadState(id: string, loadState: LoadState): void {
  const models = new Map(useViewerStore.getState().models);
  models.set(id, { ...liveModel(id), loadState });
  useViewerStore.setState({ models });
}

function liveModel(id: string): FederatedModel {
  const found = useViewerStore.getState().models.get(id);
  assert.ok(found, `model ${id} missing from the store`);
  return found as FederatedModel;
}

function captureWarnings(run: () => void): string[] {
  const seen: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { seen.push(args.map(String).join(' ')); };
  try { run(); } finally { console.warn = original; }
  return seen;
}

/** A's element, in the render frame, where it must be once converged. */
function assertAConverged(): void {
  const a = liveModel('A').geometryResult!;
  assert.deepStrictEqual(a.coordinateInfo.wasmRtcOffset, ANCHOR);
  assert.deepStrictEqual(a.meshes[0].origin, [2 - DELTA_YUP.x, 1 - DELTA_YUP.y, -3 - DELTA_YUP.z]);
  assert.deepStrictEqual(Array.from(a.meshes[0].positions), [0, 0, 0, Math.fround(0.001), 0, 0], 'positions never move');
  assert.deepStrictEqual(
    federationFrameInfo(useViewerStore.getState().models.values())?.wasmRtcOffset,
    ANCHOR,
    'the reported frame is the frame every model is drawn in',
  );
}

describe('convergeFederationRtcFrame - load order and overlapping loads', () => {
  beforeEach(() => seed([]));

  it('sequential A (raw) then B (anchored): A joins B\'s anchor', () => {
    seed([rawModel(1), anchoredModel(2)]);
    convergeFederationRtcFrame();
    assertAConverged();
  });

  it('overlapping loads, B settles first then A: converged when A settles', () => {
    // Both loads started with an empty federation, so neither got a shared
    // offset. A pre-load snapshot would have told both "no peer".
    seed([rawModel(1, 'streaming-geometry'), anchoredModel(2)]);
    convergeFederationRtcFrame(); // B's load settles
    assert.strictEqual(liveModel('A').geometryResult!.coordinateInfo.wasmRtcOffset, undefined, 'a still-streaming model is not moved');
    assert.deepStrictEqual(liveModel('A').geometryResult!.meshes[0].origin, [2, 1, -3]);

    setLoadState('A', 'complete');
    convergeFederationRtcFrame(); // A's load settles
    assertAConverged();
  });

  it('overlapping loads, A settles first then B: converged when B settles', () => {
    seed([rawModel(1), anchoredModel(2, 'streaming-geometry')]);
    convergeFederationRtcFrame(); // A's load settles; B's frame is not final yet
    assert.strictEqual(liveModel('A').geometryResult!.coordinateInfo.wasmRtcOffset, undefined);

    setLoadState('B', 'complete');
    convergeFederationRtcFrame(); // B's load settles
    assertAConverged();
  });

  it('both completion orders end in the identical scene', () => {
    const run = (first: 'A' | 'B') => {
      seed([rawModel(1, 'streaming-geometry'), anchoredModel(2, 'streaming-geometry')]);
      const second = first === 'A' ? 'B' : 'A';
      setLoadState(first, 'complete');
      convergeFederationRtcFrame();
      setLoadState(second, 'complete');
      convergeFederationRtcFrame();
      return ['A', 'B'].map((id) => {
        const g = liveModel(id).geometryResult!;
        return { offset: g.coordinateInfo.wasmRtcOffset, origin: g.meshes[0].origin };
      });
    };
    assert.deepStrictEqual(run('A'), run('B'));
  });

  it('two anchored models that each picked their own anchor converge on the earliest', () => {
    const other = { x: 1234000, y: -987000, z: 40 };
    const c = model('C', 3, geometry([mesh([0, 0, 0])], { coordinateInfo: coordInfo({ wasmRtcOffset: other }) }));
    seed([anchoredModel(2), c]);
    convergeFederationRtcFrame();
    const live = liveModel('C').geometryResult!;
    assert.deepStrictEqual(live.coordinateInfo.wasmRtcOffset, ANCHOR);
    const shift = ifcToViewerAxes({ x: ANCHOR.x - other.x, y: ANCHOR.y - other.y, z: ANCHOR.z - other.z });
    live.meshes[0].origin!.forEach((value, i) => {
      assert.ok(Math.abs(value + [shift.x, shift.y, shift.z][i]) < 1e-6, `origin[${i}] = ${value}`);
    });
  });

  it('is a no-op with no anchored settled model, and idempotent once converged', () => {
    seed([rawModel(1)]);
    convergeFederationRtcFrame();
    assert.strictEqual(liveModel('A').geometryResult!.coordinateInfo.wasmRtcOffset, undefined);

    seed([rawModel(1), anchoredModel(2)]);
    convergeFederationRtcFrame();
    const version = useViewerStore.getState().geometryContentVersion;
    convergeFederationRtcFrame();
    assert.strictEqual(useViewerStore.getState().geometryContentVersion, version, 'a converged federation is not rebuilt again');
    assertAConverged();
  });

  it('never moves a raw point cloud loaded before the anchor', () => {
    const cloud = model('P', 1, { ...geometry([]), pointClouds: [{ expressId: 1 }] } as unknown as GeometryResult);
    const before = cloud.geometryResult!.coordinateInfo;
    seed([cloud, anchoredModel(2)]);
    convergeFederationRtcFrame();
    assert.strictEqual(liveModel('P').geometryResult!.coordinateInfo, before);
    assert.deepStrictEqual(
      federationFrameInfo(useViewerStore.getState().models.values())?.wasmRtcOffset,
      ANCHOR,
      'a raw point cloud loaded first must not define the reported frame',
    );
  });

  it('carries the pre-alignment snapshot onto the anchor too', () => {
    const a = rawModel(1);
    a.preAlignment = {
      positions: [new Float32Array([0, 0, 0])],
      normals: [undefined],
      origins: [[7, 8, 9], undefined],
      coordinateInfo: coordInfo(),
      geometryAabbs: [undefined],
    } as unknown as FederatedModel['preAlignment'];
    seed([a, anchoredModel(2)]);
    convergeFederationRtcFrame();
    const snapshot = liveModel('A').preAlignment!;
    assert.deepStrictEqual(snapshot.coordinateInfo.wasmRtcOffset, ANCHOR);
    assert.deepStrictEqual(snapshot.origins, [
      [7 - DELTA_YUP.x, 8 - DELTA_YUP.y, 9 - DELTA_YUP.z],
      [-DELTA_YUP.x, -DELTA_YUP.y, -DELTA_YUP.z],
    ]);
  });
});

describe('convergeFederationRtcFrame - spatial index', () => {
  beforeEach(() => seed([]));

  it('withdraws a moved model\'s spatial index at once instead of serving it until the rebuild lands', () => {
    const stale = { stale: true } as unknown as NonNullable<FederatedModel['ifcDataStore']>['spatialIndex'];
    const a = rawModel(1);
    a.ifcDataStore = { spatialIndex: stale } as unknown as FederatedModel['ifcDataStore'];
    const a2 = { ...a, geometryResult: geometry([]) }; // no meshes: the async rebuild is skipped
    a2.geometryResult!.coordinateInfo = coordInfo();
    seed([a2, anchoredModel(2)]);
    convergeFederationRtcFrame();
    assert.deepStrictEqual(liveModel('A').geometryResult!.coordinateInfo.wasmRtcOffset, ANCHOR, 'sanity: A moved');
    assert.notStrictEqual(liveModel('A').ifcDataStore!.spatialIndex, stale, 'raycasts still read the pre-rebase index');
  });

  it('keeps the spatial index of a model that is already on the anchor', () => {
    const stale = { kept: true } as unknown as NonNullable<FederatedModel['ifcDataStore']>['spatialIndex'];
    const b = anchoredModel(2);
    b.ifcDataStore = { spatialIndex: stale } as unknown as FederatedModel['ifcDataStore'];
    seed([b]);
    convergeFederationRtcFrame();
    assert.strictEqual(liveModel('B').ifcDataStore!.spatialIndex, stale);
  });
});

describe('convergeFederationRtcFrame - GPU-instanced models', () => {
  beforeEach(() => seed([]));

  const box = () => ({ min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] });

  it('refuses - visibly, by name - an instanced model, and still converges the others', () => {
    const instanced = model('I', 1, geometry([mesh([2, 1, -3]), mesh([0, 0, 0], 2)], {
      instancedGeometryAabbs: new Map([[7, box()]]),
    }));
    const stale = { stale: true } as unknown as NonNullable<FederatedModel['ifcDataStore']>['spatialIndex'];
    instanced.ifcDataStore = { spatialIndex: stale } as unknown as FederatedModel['ifcDataStore'];
    seed([instanced, rawModel(1.5), anchoredModel(2)]);

    const warnings = captureWarnings(() => convergeFederationRtcFrame());

    const live = liveModel('I');
    assert.strictEqual(live.geometryResult!.coordinateInfo.wasmRtcOffset, undefined, 'a refused model keeps its frame');
    assert.deepStrictEqual(live.geometryResult!.meshes[0].origin, [2, 1, -3]);
    assert.deepStrictEqual(live.geometryResult!.instancedGeometryAabbs!.get(7), box());
    assert.strictEqual(live.ifcDataStore!.spatialIndex, stale, 'a refused model keeps its (still correct) index');
    assert.ok(
      warnings.some((line) => line.includes('#4897') && line.includes('I use GPU-instanced')),
      `the refusal must name the model; console.warn saw ${JSON.stringify(warnings)}`,
    );
    assertAConverged();
  });

  it('refuses on a class-2 template alone, with geometry hashing off', () => {
    seed([model('I', 1, geometry([mesh([2, 1, -3]), mesh([0, 0, 0], 2)])), anchoredModel(2)]);
    captureWarnings(() => convergeFederationRtcFrame());
    assert.deepStrictEqual(liveModel('I').geometryResult!.meshes[0].origin, [2, 1, -3]);
  });

  it('says nothing when nothing needs to move', () => {
    const instanced = model('I', 3, geometry([mesh([0, 0, 0], 2)], {
      coordinateInfo: coordInfo({ wasmRtcOffset: { ...ANCHOR } }),
    }));
    seed([anchoredModel(2), instanced]);
    const warnings = captureWarnings(() => convergeFederationRtcFrame());
    assert.deepStrictEqual(warnings, [], 'an instanced model already on the anchor is not a refusal');
  });
});
