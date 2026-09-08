/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Switching the federation anchor twice must leave the model that started as
 * the anchor exactly as it was loaded (#2007).
 *
 * The old loop `continue`d past the anchor before the restore step, so X → A →
 * X left X's vertices baked into A's frame while X defined the federation
 * frame. Asserting "no alignment ran on the final pass" would have passed on
 * that code — the assertions here are byte-level identity against the original
 * geometry, and identity of the OTHER model against the frame it landed in the
 * first time X was the anchor.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo, EntityWorldAabb, GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { ModelGeoref } from './federationAlign.js';
import {
  capturePreAlignment,
  realignFederationModels,
  restorePreAlignment,
  type RealignableModel,
} from './federationRealign.js';

function coordinateInfo(over?: Partial<CoordinateInfo>): CoordinateInfo {
  return {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    hasLargeCoordinates: false,
    ...over,
  };
}

function georef(
  conversion: Partial<MapConversion>,
  crsName = 'EPSG:2056',
): Omit<ModelGeoref, 'coordinateInfo'> {
  return {
    mapConversion: {
      id: 1,
      sourceCRS: 2,
      targetCRS: 3,
      eastings: 0,
      northings: 0,
      orthogonalHeight: 0,
      xAxisAbscissa: 1,
      xAxisOrdinate: 0,
      scale: 1,
      ...conversion,
    },
    projectedCRS: { id: 4, name: crsName, mapUnitScale: 1 } as ProjectedCRS,
    lengthUnitScale: 1,
  };
}

/**
 * A box mesh with REAL unit normals. Zero-length normals survive the alignment
 * untouched (the rotation short-circuits on them), so a fixture built with
 * zeroed normals could not tell a restored normal from an unrestored one.
 */
function boxMesh(
  expressId: number,
  place: [number, number, number],
  localOrigin?: [number, number, number],
): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const o = localOrigin ?? [0, 0, 0];
  for (const x of [0, 4]) {
    for (const y of [0, 1]) {
      for (const z of [0, 2]) {
        // Local-frame vertices: world = origin + position, exactly as the wasm
        // pipeline emits them. Alignment folds the origin in and zeroes it, so a
        // fixture without origins cannot tell a complete restore from a partial one.
        positions.push(x + place[0] - o[0], y + place[1] - o[1], z + place[2] - o[2]);
        const len = Math.sqrt(3);
        normals.push(
          (x === 0 ? -1 : 1) / len,
          (y === 0 ? -1 : 1) / len,
          (z === 0 ? -1 : 1) / len,
        );
      }
    }
  }
  return {
    expressId,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    geometryHash: 7n,
    ...(localOrigin ? { origin: [...localOrigin] as [number, number, number] } : {}),
    geometryAabb: {
      min: [place[0], place[1], place[2]],
      max: [place[0] + 4, place[1] + 1, place[2] + 2],
    },
  } as MeshData;
}

interface TestModel extends RealignableModel {
  /** The model's own georef, minus the coordinateInfo the resolver supplies. */
  ownGeoref: Omit<ModelGeoref, 'coordinateInfo'>;
}

function model(
  meshes: MeshData[],
  info: CoordinateInfo,
  ownGeoref: Omit<ModelGeoref, 'coordinateInfo'>,
  instanced?: Map<number, EntityWorldAabb>,
): TestModel {
  const geometryResult: GeometryResult = {
    meshes,
    totalTriangles: meshes.length,
    totalVertices: meshes.reduce((n, m) => n + m.positions.length / 3, 0),
    coordinateInfo: info,
    ...(instanced ? { instancedGeometryAabbs: instanced } : {}),
  };
  return { geometryResult, ownGeoref, federationAlignmentStatus: 'none' };
}

/**
 * Exactly what `extractModelGeoref` does for the fields that matter here: the
 * MapConversion and CRS come from the file, the `coordinateInfo` is whatever
 * the model's geometry carries AT THE MOMENT OF THE CALL. That last part is
 * what makes reading the anchor's frame before restoring it observable.
 */
function resolveGeoref(_modelId: string, m: TestModel): ModelGeoref {
  return { ...m.ownGeoref, coordinateInfo: m.geometryResult?.coordinateInfo };
}

function applyPatch(models: Map<string, TestModel>) {
  return (modelId: string, patch: Partial<RealignableModel>): void => {
    const target = models.get(modelId);
    if (!target) throw new Error(`updateModel called for unknown model ${modelId}`);
    Object.assign(target, patch);
  };
}

async function realign(models: Map<string, TestModel>, anchorModelId: string) {
  const anchor = models.get(anchorModelId);
  if (!anchor) throw new Error(`no such anchor ${anchorModelId}`);
  return realignFederationModels<TestModel>({
    models: Array.from(models.entries()),
    anchorModelId,
    // Resolved BEFORE the call, exactly as `findReferenceGeorefModel` does it —
    // so this georef carries the anchor's frame as it stands pre-restore.
    anchorGeoref: resolveGeoref(anchorModelId, anchor),
    resolveGeoref,
    updateModel: applyPatch(models),
  });
}

/**
 * `world = origin + position` — what the renderer, the spatial index and every
 * bounds query actually see. Asserting on this rather than on whether `origin`
 * is present is what catches the failure mode this repo keeps hitting: a
 * world-space consumer that drops the folded origin misplaces geometry by
 * exactly that offset, and it reads as a rendering glitch rather than a data bug.
 */
function worldPositionsOf(mesh: MeshData): Float32Array {
  const o = mesh.origin ?? [0, 0, 0];
  const out = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    out[i] = mesh.positions[i] + o[0];
    out[i + 1] = mesh.positions[i + 1] + o[1];
    out[i + 2] = mesh.positions[i + 2] + o[2];
  }
  return out;
}

function bytesOf(array: Float32Array): Uint8Array {
  return new Uint8Array(array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength));
}

function assertBytesEqual(actual: Float32Array, expected: Float32Array, label: string): void {
  assert.deepStrictEqual(
    Buffer.from(bytesOf(actual)).toString('hex'),
    Buffer.from(bytesOf(expected)).toString('hex'),
    label,
  );
}

function assertBytesDiffer(actual: Float32Array, expected: Float32Array, label: string): void {
  assert.notDeepStrictEqual(
    Buffer.from(bytesOf(actual)).toString('hex'),
    Buffer.from(bytesOf(expected)).toString('hex'),
    label,
  );
}

/** X and A: same projected CRS, 2500 m apart, 30° between their grid norths,
 *  and different RTC choices so the two frames really are two frames. */
function federation(): { models: Map<string, TestModel>; x: TestModel; a: TestModel } {
  const theta = Math.PI / 6;
  const x = model(
    // Two meshes: one on the wasm local-frame path (an origin), one without.
    // Absent must stay absent — a restore that hands out a [0,0,0] origin gives
    // the renderer a local frame the mesh never had.
    [boxMesh(11, [0, 0, 0], [3, 0, -2]), boxMesh(12, [10, 0, 5])],
    coordinateInfo({ wasmRtcOffset: { x: 1000, y: 500, z: 0 } }),
    georef({ eastings: 2500, xAxisAbscissa: Math.cos(theta), xAxisOrdinate: Math.sin(theta) }),
    new Map<number, EntityWorldAabb>([[99, { min: [0, 0, 0], max: [2, 2, 2] }]]),
  );
  const a = model(
    [boxMesh(21, [7, 0, -3], [-1, 0, 4])],
    // shiftedBounds = originalBounds - originShift (createCoordinateInfo's
    // invariant); realignFederationModels only round-trips this field
    // opaquely (never reads it), but a fixture no producer could emit is
    // still worth avoiding.
    coordinateInfo({
      originShift: { x: 20, y: 0, z: -5 },
      shiftedBounds: { min: { x: -20, y: 0, z: 5 }, max: { x: -19, y: 1, z: 6 } },
    }),
    georef({ eastings: 0, northings: 800 }),
  );
  const models = new Map<string, TestModel>([['X', x], ['A', a]]);
  return { models, x, a };
}

describe('realignFederationModels — switching the anchor back restores it (#2007)', () => {
  it('leaves X byte-identical to its original geometry after X → A → X', async () => {
    const { models, x, a } = federation();
    const xMesh = x.geometryResult!.meshes[0];
    const aMesh = a.geometryResult!.meshes[0];
    const xOriginalPositions = new Float32Array(xMesh.positions);
    const xOriginalNormals = new Float32Array(xMesh.normals!);
    // Cloned, not referenced. A baseline that aliases the live object cannot
    // fail: the restore would be compared against whatever the restore itself
    // produced.
    const xOriginalInfo = structuredClone(x.geometryResult!.coordinateInfo);
    const xOriginalBox = structuredClone(xMesh.geometryAabb!);
    const xOriginalOrigin = [...xMesh.origin!] as [number, number, number];
    const xOriginalWorld = worldPositionsOf(xMesh);
    const aOriginalWorldOfSecondMesh = worldPositionsOf(x.geometryResult!.meshes[1]);
    const xOriginalInstanced = structuredClone(x.geometryResult!.instancedGeometryAabbs!);

    // Round 1 — X anchors. A is baked into X's frame; X is untouched.
    await realign(models, 'X');
    assertBytesEqual(xMesh.positions, xOriginalPositions, 'the anchor must not move on its own pass');
    const aPositionsUnderX = new Float32Array(aMesh.positions);
    const aNormalsUnderX = new Float32Array(aMesh.normals!);
    const aBoxUnderX = aMesh.geometryAabb!;

    // Round 2 — A anchors. X is now a non-anchor and gets baked into A's frame.
    await realign(models, 'A');
    assertBytesDiffer(xMesh.positions, xOriginalPositions, 'fixture: X must really leave its own frame');
    assert.ok(x.preAlignment, 'X must have been snapshotted when it was aligned');

    // Round 3 — X anchors again. This is the defect: the old loop skipped the
    // restore along with the alignment.
    const third = await realign(models, 'X');

    assertBytesEqual(xMesh.positions, xOriginalPositions, 'X positions must be byte-identical again');
    assertBytesEqual(xMesh.normals!, xOriginalNormals, 'X normals must be byte-identical again');
    assert.deepStrictEqual(xMesh.geometryAabb, xOriginalBox, 'X world box must be its original');
    // The consequence, not the mechanism: alignment folds the origin into the
    // vertices and zeroes it, so a restore that puts the local-frame positions
    // back without the origin leaves the mesh sitting at `position` instead of
    // `origin + position` — displaced by exactly the folded offset.
    assertBytesEqual(
      worldPositionsOf(xMesh),
      xOriginalWorld,
      'X must sit at the same WORLD coordinates it loaded at',
    );
    assertBytesEqual(
      worldPositionsOf(x.geometryResult!.meshes[1]),
      aOriginalWorldOfSecondMesh,
      'the origin-less mesh must sit where it loaded too',
    );
    assert.deepStrictEqual(
      xMesh.origin,
      xOriginalOrigin,
      'and by the right mechanism: the local-frame origin itself is back',
    );
    // Numerically inert (a [0,0,0] origin adds nothing) but structurally wrong:
    // capture and restore must round-trip, and inventing a channel the capture
    // never saw is the defect `federationAlign.test.ts` pins for the instanced
    // boxes. Downstream code reads presence as "this mesh is on the local-frame
    // path".
    assert.equal(
      x.geometryResult!.meshes[1].origin,
      undefined,
      'a mesh that never had an origin must not be given one',
    );
    assert.deepStrictEqual(
      x.geometryResult!.instancedGeometryAabbs,
      xOriginalInstanced,
      'X instanced-only boxes must be their originals',
    );
    assert.deepStrictEqual(
      x.geometryResult!.coordinateInfo,
      xOriginalInfo,
      'X must be back on its own RTC/shift frame',
    );
    assert.deepStrictEqual(
      [...third.movedModelIds].sort(),
      ['A', 'X'],
      'the caller has to learn the anchor geometry changed, or the GPU buffers and '
      + 'the spatial index both keep describing the old frame',
    );
    assert.equal(x.federationAlignmentStatus, 'anchor');

    // And the frame the rest of the federation was aligned INTO is X's own
    // again: A lands exactly where it landed the first time X anchored. This is
    // the half that restoring the anchor too late would still get wrong — the
    // anchor georef would carry A's coordinateInfo.
    assertBytesEqual(aMesh.positions, aPositionsUnderX, 'A must land in the same frame as in round 1');
    assertBytesEqual(aMesh.normals!, aNormalsUnderX, 'A normals must match round 1');
    assert.deepStrictEqual(aMesh.geometryAabb, aBoxUnderX, 'A world box must match round 1');
    assert.deepStrictEqual(aMesh.origin, [0, 0, 0], 'A was aligned, so its origin is folded in again');
    assert.equal(third.counts.aligned, 1);
    assert.equal(third.counts.skipped, 0);
    assert.equal(third.counts.failed, 0);
  });

  it('snapshots the coordinate frame by value, so a later in-place edit cannot rewrite it', () => {
    // Positions, normals and origins are copied into the snapshot; the FRAME
    // they are relative to has to be copied too. Holding the live object means
    // anything that edits it in place — `useIfcLoader.ts` does exactly that to
    // `wasmRtcOffset` on the streaming path — silently rewrites the baseline,
    // and the restore then puts the model back into the edited frame instead of
    // its own, with nothing to notice because snapshot and geometry are one
    // value.
    const geometry = federation().x.geometryResult!;
    const before = structuredClone(geometry.coordinateInfo);

    const snapshot = capturePreAlignment(geometry);

    // Every depth the frame has: a scalar, a nested vector, and a bounds corner
    // two levels down. The corner is the one that catches a copy that stopped a
    // level too early — `restorePreAlignment` spreads `originalBounds` and
    // `shiftedBounds` one level, which does NOT copy their `min`/`max`.
    geometry.coordinateInfo.hasLargeCoordinates = !geometry.coordinateInfo.hasLargeCoordinates;
    geometry.coordinateInfo.originShift.x += 137;
    geometry.coordinateInfo.originalBounds.min.x -= 42;
    geometry.coordinateInfo.shiftedBounds.max.z += 7;
    geometry.coordinateInfo.wasmRtcOffset = { x: 4, y: 5, z: 6 };

    restorePreAlignment(geometry, snapshot);

    assert.deepStrictEqual(
      geometry.coordinateInfo,
      before,
      'the restored frame must be the captured one, not the edited one',
    );
  });

  it('snapshots the instanced-only box channel by value too', () => {
    const geometry = federation().x.geometryResult!;
    const before = structuredClone(geometry.instancedGeometryAabbs!);

    const snapshot = capturePreAlignment(geometry);

    geometry.instancedGeometryAabbs!.set(1234, { min: [0, 0, 0], max: [1, 1, 1] });
    geometry.instancedGeometryAabbs!.delete(99);

    restorePreAlignment(geometry, snapshot);

    assert.deepStrictEqual(
      geometry.instancedGeometryAabbs,
      before,
      'the restored channel must be the captured one, not the edited one',
    );
  });

  it('hands the restore its own copy, so editing the restored frame cannot corrupt the snapshot', () => {
    // The mirror of the capture case, and just as silent: if the restore hands
    // the geometry the snapshot's own nested objects, the next in-place edit of
    // the live frame rewrites the baseline that the NEXT re-align will restore
    // from. `{ ...coordinateInfo, originalBounds: { ...originalBounds } }` looks
    // deep enough and is not — `min`/`max` are still shared.
    const geometry = federation().x.geometryResult!;
    const before = structuredClone(geometry.coordinateInfo);
    const beforeInstanced = structuredClone(geometry.instancedGeometryAabbs!);
    const snapshot = capturePreAlignment(geometry);

    restorePreAlignment(geometry, snapshot);
    geometry.coordinateInfo.originalBounds.min.x -= 42;
    geometry.coordinateInfo.originShift.y += 9;
    geometry.instancedGeometryAabbs!.delete(99);
    // A second re-align restores from the same snapshot.
    restorePreAlignment(geometry, snapshot);

    assert.deepStrictEqual(
      geometry.coordinateInfo,
      before,
      'the second restore must still produce the captured frame',
    );
    assert.deepStrictEqual(
      geometry.instancedGeometryAabbs,
      beforeInstanced,
      'the second restore must still produce the captured channel',
    );
  });

  it('clears the restored anchor\'s snapshots so nothing stale can be re-applied', async () => {
    const { models, x } = federation();
    await realign(models, 'X');
    await realign(models, 'A');
    assert.ok(x.preAlignment, 'fixture: X must be carrying a snapshot before the switch back');

    await realign(models, 'X');

    // One field, so there is no way to clear four channels and forget the fifth
    // — which is the same reason "positions but no origins" is now unrepresentable.
    assert.equal(x.preAlignment, undefined, 'the whole snapshot must be cleared');
  });

  it('places a model the same way no matter which anchor came before', async () => {
    // Switching TO an anchor must give what loading with that anchor from the
    // start would: the frame X lands in is A's OWN frame, not whatever frame A
    // was last baked into. This is where reading the anchor's `coordinateInfo`
    // before restoring it shows up — and it is invisible in a bare X → A → X
    // round trip, because two models converge on the first anchor's frame and
    // the two errors then cancel on the way back.
    const direct = federation();
    await realign(direct.models, 'A');
    const directX = direct.x.geometryResult!.meshes[0].positions;

    const viaX = federation();
    await realign(viaX.models, 'X');
    await realign(viaX.models, 'A');

    assertBytesDiffer(
      directX,
      new Float32Array(federation().x.geometryResult!.meshes[0].positions),
      'fixture: anchoring on A must really move X',
    );
    assertBytesEqual(
      viaX.x.geometryResult!.meshes[0].positions,
      directX,
      'X under anchor A must not depend on X having anchored first',
    );
    assertBytesEqual(
      viaX.a.geometryResult!.meshes[0].positions,
      direct.a.geometryResult!.meshes[0].positions,
      'the anchor itself must come back to the same frame either way',
    );
  });

  it('re-aligns repeatedly without drift once the anchor stays put', async () => {
    // Three passes on the same anchor must be idempotent: the restore is what
    // makes pass N start from the same geometry pass 1 did.
    const { models, a } = federation();
    const aMesh = a.geometryResult!.meshes[0];
    await realign(models, 'X');
    const first = new Float32Array(aMesh.positions);
    const firstNormals = new Float32Array(aMesh.normals!);
    await realign(models, 'X');
    await realign(models, 'X');
    assertBytesEqual(aMesh.positions, first, 'repeated re-aligns must not compound');
    assertBytesEqual(aMesh.normals!, firstNormals, 'repeated re-aligns must not compound on normals');
  });

  it('restores a model with no georeference and reports it as skipped', async () => {
    const { models, a } = federation();
    const aMesh = a.geometryResult!.meshes[0];
    const aOriginal = new Float32Array(aMesh.positions);
    await realign(models, 'X');
    assertBytesDiffer(aMesh.positions, aOriginal, 'fixture: A must really have been aligned');

    // A loses its georef (the user cleared the edit, say). It has to go back to
    // its own frame rather than stay baked into the anchor's.
    const anchor = models.get('X')!;
    const result = await realignFederationModels<TestModel>({
      models: Array.from(models.entries()),
      anchorModelId: 'X',
      anchorGeoref: resolveGeoref('X', anchor),
      resolveGeoref: (modelId, m) => (modelId === 'A' ? null : resolveGeoref(modelId, m)),
      updateModel: applyPatch(models),
    });

    assertBytesEqual(aMesh.positions, aOriginal, 'A must be back in its own frame');
    assert.equal(a.federationAlignmentStatus, 'none');
    assert.equal(result.counts.skipped, 1);
    assert.equal(result.counts.aligned, 0);
    // Skipped by the alignment but still MOVED by the restore. Anything keyed
    // on the align count — the GPU content version, the spatial index — misses
    // exactly this model (#2013).
    assert.deepStrictEqual(result.movedModelIds, ['A'], 'a restored-then-skipped model still moved');
  });

  it('clears the status of a model with no geometry instead of leaving it stale', async () => {
    // A model that cannot participate at all — no `geometryResult` — used to be
    // counted as skipped without being written to, so it kept the badge from the
    // PREVIOUS anchor. The models panel and BasepointOverlay would then show
    // `Aligned` for a model nothing in this pass aligned.
    const { models } = federation();
    await realign(models, 'X');
    const a = models.get('A')!;
    assert.equal(a.federationAlignmentStatus, 'same-crs', 'fixture: A must carry a stale-able status');

    a.geometryResult = undefined;
    const second = await realign(models, 'X');

    assert.equal(
      a.federationAlignmentStatus,
      'none',
      'a model that could not be aligned must not keep claiming it was',
    );
    assert.equal(second.counts.skipped, 1);
    assert.deepStrictEqual(second.movedModelIds, [], 'nothing moved: there was no geometry to move');
  });

  it('reports only what moved when the anchor never left its own frame', async () => {
    const { models } = federation();
    const first = await realign(models, 'X');
    assert.deepStrictEqual(
      first.movedModelIds,
      ['A'],
      'a never-aligned anchor has nothing to restore, so only the aligned model moved',
    );
  });

  it('reports a model the restore moved even when its new alignment is identity', async () => {
    // A is baked into X's frame, then the anchor moves to B — and B's georef is
    // A's own, so A's new alignment is `identity` and moves nothing. The RESTORE
    // is what put A back. A moved-set keyed on the alignment status alone would
    // leave A's GPU buffers and its spatial index describing X's frame while the
    // geometry sits in A's.
    const shared = georef({ eastings: 0, northings: 800 });
    const theta = Math.PI / 6;
    const models = new Map<string, TestModel>([
      ['X', model(
        [boxMesh(41, [0, 0, 0])],
        coordinateInfo(),
        georef({ eastings: 2500, xAxisAbscissa: Math.cos(theta), xAxisOrdinate: Math.sin(theta) }),
      )],
      ['A', model([boxMesh(42, [7, 0, -3])], coordinateInfo(), shared)],
      ['B', model([boxMesh(43, [1, 0, 9])], coordinateInfo(), shared)],
    ]);
    const a = models.get('A')!;
    const aMesh = a.geometryResult!.meshes[0];
    const aOriginal = new Float32Array(aMesh.positions);

    await realign(models, 'X');
    assertBytesDiffer(aMesh.positions, aOriginal, 'fixture: A must really be baked into X\'s frame');

    const second = await realign(models, 'B');

    assert.equal(a.federationAlignmentStatus, 'identity', 'fixture: the new alignment must be a no-op');
    assertBytesEqual(aMesh.positions, aOriginal, 'the restore put A back in its own frame');
    assert.ok(
      second.movedModelIds.includes('A'),
      `the restore moved A even though the alignment did not — got ${JSON.stringify(second.movedModelIds)}`,
    );
  });

  it('reports nothing moved when every model is already where it belongs', async () => {
    // Anchor with no georef difference to anyone: the alignment is `identity`
    // and no snapshot exists, so nothing is rewritten and nothing downstream
    // needs invalidating. Over-reporting here would rebuild every BVH and
    // re-upload every GPU buffer on each click of Re-align.
    const same = georef({ eastings: 0 });
    const models = new Map<string, TestModel>([
      ['X', model([boxMesh(31, [0, 0, 0])], coordinateInfo(), same)],
      ['A', model([boxMesh(32, [5, 0, 5])], coordinateInfo(), same)],
    ]);
    const result = await realign(models, 'X');
    assert.deepStrictEqual(result.movedModelIds, [], 'an identity alignment moves nothing');
    assert.equal(result.counts.aligned, 1, 'it still counts as handled');
  });
});
