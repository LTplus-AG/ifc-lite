/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Federation alignment must carry the per-entity world AABB (#1891) into the
 * anchor's frame along with the vertices it describes.
 *
 * `MeshData.geometryAabb` is what makes compare say "Moved · 2.500 m" instead
 * of a bare `Moved`. It is an ABSOLUTE world box while `positions` are
 * viewer-local, so the two are related by a per-model offset — leave the box
 * behind when the vertices are re-baked into the anchor's frame and every
 * reported distance is off by the alignment, which reads as a plausible
 * number rather than as a failure.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo, EntityWorldAabb, GeometryResult, MeshData } from '@ifc-lite/geometry';
import { alignGeometryToReference, type ModelGeoref } from './federationAlign.js';

function mapConversion(over: Partial<MapConversion>): MapConversion {
  return {
    id: 1,
    sourceCRS: 2,
    targetCRS: 3,
    eastings: 0,
    northings: 0,
    orthogonalHeight: 0,
    xAxisAbscissa: 1,
    xAxisOrdinate: 0,
    scale: 1,
    ...over,
  };
}

function projectedCrs(name: string): ProjectedCRS {
  return { id: 4, name, mapUnitScale: 1 } as ProjectedCRS;
}

function georef(
  conversion: Partial<MapConversion>,
  crsName = 'EPSG:2056',
  coordinateInfo?: CoordinateInfo,
): ModelGeoref {
  return {
    mapConversion: mapConversion(conversion),
    projectedCRS: projectedCrs(crsName),
    lengthUnitScale: 1,
    ...(coordinateInfo ? { coordinateInfo } : {}),
  };
}

function coordinateInfo(over?: Partial<CoordinateInfo>): CoordinateInfo {
  return {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    hasLargeCoordinates: false,
    ...over,
  };
}

/**
 * One entity whose mesh is the axis-aligned box `[min, max]` itself, so its
 * world AABB is exactly the bounds of its own vertices. That identity is what
 * lets a test assert box-follows-mesh without re-deriving the alignment maths
 * a second time (a second derivation would drift with the first).
 */
function boxMesh(
  expressId: number,
  min: [number, number, number],
  max: [number, number, number],
  offset: [number, number, number] = [0, 0, 0],
): MeshData {
  const corners: number[] = [];
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) {
        corners.push(x - offset[0], y - offset[1], z - offset[2]);
      }
    }
  }
  return {
    expressId,
    positions: new Float32Array(corners),
    normals: new Float32Array(corners.length),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    geometryHash: 7n,
    geometryAabb: { min: [...min], max: [...max] },
  } as MeshData;
}

function geometry(meshes: MeshData[], info?: CoordinateInfo): GeometryResult {
  return {
    meshes,
    totalTriangles: 1,
    totalVertices: meshes.reduce((n, m) => n + m.positions.length / 3, 0),
    coordinateInfo: info ?? coordinateInfo(),
  };
}

/** Bounds of `positions + origin + totalOffset` — the frame `geometryAabb`
 *  claims to be in (absolute world, offsets folded back in). */
function worldBoundsOfPositions(
  meshes: readonly MeshData[],
  totalOffset: [number, number, number],
): EntityWorldAabb {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    const o = mesh.origin ?? [0, 0, 0];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const v = mesh.positions[i + axis] + o[axis] + totalOffset[axis];
        if (v < min[axis]) min[axis] = v;
        if (v > max[axis]) max[axis] = v;
      }
    }
  }
  return { min, max };
}

function assertBoxClose(
  actual: EntityWorldAabb | undefined,
  expected: EntityWorldAabb,
  eps = 1e-3,
  label = '',
): void {
  assert.ok(actual, `${label} expected a box, got ${String(actual)}`);
  for (let axis = 0; axis < 3; axis += 1) {
    assert.ok(
      Math.abs(actual.min[axis] - expected.min[axis]) < eps,
      `${label} min[${axis}]: expected ${expected.min[axis]}, got ${actual.min[axis]}`,
    );
    assert.ok(
      Math.abs(actual.max[axis] - expected.max[axis]) < eps,
      `${label} max[${axis}]: expected ${expected.max[axis]}, got ${actual.max[axis]}`,
    );
  }
}

describe('alignGeometryToReference — the world AABB rides with the vertices (#1891)', () => {
  it('translates the box by the same amount it translates the mesh (same CRS)', async () => {
    const mesh = boxMesh(11, [0, 0, 0], [1, 2, 3]);
    const geom = geometry([mesh]);

    // +2500 m of easting between the two MapConversions, no rotation: the
    // documented acceptance case (a 2.5 m wall move) scaled up to a
    // federation-sized offset.
    const status = await alignGeometryToReference(
      geom,
      georef({ eastings: 2500 }),
      georef({ eastings: 0 }),
    );
    assert.equal(status, 'same-crs');

    assert.ok(Math.abs(mesh.positions[0] - 2500) < 1e-3, 'vertex must have moved +2500 in X');
    assertBoxClose(mesh.geometryAabb, { min: [2500, 0, 0], max: [2501, 2, 3] }, 1e-3, 'translated');
  });

  it('re-measures a meshed entity from its aligned vertices, not from its old box', async () => {
    // Re-boxing a ROTATED box inflates it — on Building-Architecture.ifc
    // aligned to Infra-Bridge.ifc (60° apart) by 0.87 m, against a 1 mm
    // reshapeTolerance, which would read as `reshaped` against an unaligned
    // side that kept its tight box. An entity that has meshes is therefore
    // re-MEASURED. A deliberately oversized input box makes the two strategies
    // give different answers: corner-transforming would keep the 10 m box.
    const mesh = boxMesh(19, [0, 0, 0], [1, 1, 1]);
    mesh.geometryAabb = { min: [-10, -10, -10], max: [10, 10, 10] };
    const geom = geometry([mesh]);

    const status = await alignGeometryToReference(
      geom,
      georef({ eastings: 2500, xAxisAbscissa: Math.cos(Math.PI / 6), xAxisOrdinate: Math.sin(Math.PI / 6) }),
      georef({ eastings: 0 }),
    );
    assert.equal(status, 'same-crs');

    assertBoxClose(mesh.geometryAabb, worldBoundsOfPositions([mesh], [0, 0, 0]), 1e-5, 'measured');
    const span = (b: EntityWorldAabb, axis: number) => b.max[axis] - b.min[axis];
    assert.ok(span(mesh.geometryAabb!, 1) < 2, `Y span was ${span(mesh.geometryAabb!, 1)}, expected ~1`);
  });

  it('re-derives an instanced-only box from all eight corners under rotation', async () => {
    // The instanced channel has no vertices here, so it keeps the corner
    // transform. Pinning it against a MESH built from the same box's corners
    // is what makes a min/max-only shortcut visible: for a corner cloud the
    // measured box and the eight-corner box are the same answer.
    const probe = boxMesh(20, [0, 0, 0], [4, 1, 2]);
    const geom = geometry([probe]);
    geom.instancedGeometryAabbs = new Map<number, EntityWorldAabb>([
      [99, { min: [0, 0, 0], max: [4, 1, 2] }],
    ]);

    await alignGeometryToReference(
      geom,
      georef({ xAxisAbscissa: Math.cos(Math.PI / 6), xAxisOrdinate: Math.sin(Math.PI / 6) }),
      georef({ xAxisAbscissa: 1, xAxisOrdinate: 0 }),
    );

    assertBoxClose(geom.instancedGeometryAabbs?.get(99), probe.geometryAabb!, 1e-3, 'instanced rotated');
  });

  it('re-derives the box from all eight corners under a rotating alignment', async () => {
    // 30° between the two grid norths — deliberately NOT a right angle. A
    // quarter turn maps a box onto a box, so `min`/`max` alone would survive
    // it; at 30° the true AABB is strictly larger than the box spanned by two
    // opposite corners, and mapping only those two loses most of the Z extent.
    // Same hazard `frame_swap.rs` documents for the Z-up→Y-up swap.
    const theta = Math.PI / 6;
    const mesh = boxMesh(12, [0, 0, 0], [4, 1, 2]);
    const geom = geometry([mesh]);

    const status = await alignGeometryToReference(
      geom,
      georef({ xAxisAbscissa: Math.cos(theta), xAxisOrdinate: Math.sin(theta) }),
      georef({ xAxisAbscissa: 1, xAxisOrdinate: 0 }),
    );
    assert.equal(status, 'same-crs');

    const expected = worldBoundsOfPositions([mesh], [0, 0, 0]);
    assertBoxClose(mesh.geometryAabb, expected, 1e-3, 'rotated');
    for (let axis = 0; axis < 3; axis += 1) {
      assert.ok(
        mesh.geometryAabb!.min[axis] <= mesh.geometryAabb!.max[axis],
        `min must stay <= max on axis ${axis}`,
      );
    }
    // A rotated 4 x 2 footprint bounds to (4cosθ + 2sinθ) x (4sinθ + 2cosθ).
    // Both spans GROW; the two-corner shortcut shrinks Z to 0.27.
    const span = (b: EntityWorldAabb, axis: number) => b.max[axis] - b.min[axis];
    assert.ok(
      Math.abs(span(mesh.geometryAabb!, 0) - (4 * Math.cos(theta) + 2 * Math.sin(theta))) < 1e-3,
      `X span was ${span(mesh.geometryAabb!, 0)}`,
    );
    assert.ok(
      Math.abs(span(mesh.geometryAabb!, 2) - (4 * Math.sin(theta) + 2 * Math.cos(theta))) < 1e-3,
      `Z span was ${span(mesh.geometryAabb!, 2)}`,
    );
  });

  it('lands the box in the anchor frame when the two models have different RTC offsets', async () => {
    // Source vertices are RTC-relative to (1000, 0, 500) in IFC Z-up; the
    // reference model chose a different RTC. The box is absolute, so it must
    // come out absolute in the ANCHOR's frame, not the source's.
    const sourceInfo = coordinateInfo({ wasmRtcOffset: { x: 1000, y: 500, z: 0 } });
    const refInfo = coordinateInfo({ wasmRtcOffset: { x: 200, y: 100, z: 0 } });
    // rtc Y-up = (x, z, -y) → source (1000, 0, -500), reference (200, 0, -100).
    const mesh = boxMesh(13, [1000, 0, -500], [1004, 1, -498], [1000, 0, -500]);
    const geom = geometry([mesh], sourceInfo);

    const status = await alignGeometryToReference(
      geom,
      georef({ eastings: 2500 }, 'EPSG:2056', sourceInfo),
      georef({ eastings: 0 }, 'EPSG:2056', refInfo),
    );
    assert.equal(status, 'same-crs');

    const expected = worldBoundsOfPositions([mesh], [200, 0, -100]);
    assertBoxClose(mesh.geometryAabb, expected, 1e-3, 'rtc');
    // And it really moved: +2500 easting on top of the RTC rebase.
    assert.ok(Math.abs(mesh.geometryAabb!.min[0] - 3500) < 1e-3, `got ${mesh.geometryAabb!.min[0]}`);
  });

  it('lands an instanced-only box in the anchor frame across differing RTC offsets', async () => {
    // The corner path is the only one that has to do the frame arithmetic
    // itself — a meshed entity gets its offset for free from the vertices the
    // alignment already rewrote. So the instanced channel is where "strip the
    // source offset, re-apply the reference offset" has to be pinned. The
    // probe mesh spans the identical absolute box and reaches the same answer
    // by the independent measured route.
    const sourceInfo = coordinateInfo({ wasmRtcOffset: { x: 1000, y: 500, z: 0 } });
    const refInfo = coordinateInfo({ wasmRtcOffset: { x: 200, y: 100, z: 0 } });
    // rtc Y-up = (x, z, -y) → source offset (1000, 0, -500), reference (200, 0, -100).
    const probe = boxMesh(21, [1000, 0, -500], [1004, 1, -498], [1000, 0, -500]);
    const geom = geometry([probe], sourceInfo);
    geom.instancedGeometryAabbs = new Map<number, EntityWorldAabb>([
      [99, { min: [1000, 0, -500], max: [1004, 1, -498] }],
    ]);

    await alignGeometryToReference(
      geom,
      georef(
        { eastings: 2500, xAxisAbscissa: Math.cos(Math.PI / 6), xAxisOrdinate: Math.sin(Math.PI / 6) },
        'EPSG:2056',
        sourceInfo,
      ),
      georef({ eastings: 0 }, 'EPSG:2056', refInfo),
    );

    const expected = worldBoundsOfPositions([probe], [200, 0, -100]);
    assertBoxClose(geom.instancedGeometryAabbs?.get(99), expected, 1e-3, 'instanced rtc');
    // Not a no-op fixture: the box really did leave its source frame.
    assert.ok(
      Math.abs(geom.instancedGeometryAabbs!.get(99)!.min[0] - 1000) > 100,
      `instanced box X min stayed at ${geom.instancedGeometryAabbs!.get(99)!.min[0]}`,
    );
  });

  it('carries every submesh of one entity, including a shared box object', async () => {
    // Submeshes of one entity share ONE box object off the wasm pass. Mutating
    // it in place would transform it once per submesh.
    const shared: EntityWorldAabb = { min: [0, 0, 0], max: [1, 1, 1] };
    const a = boxMesh(14, [0, 0, 0], [1, 1, 1]);
    const b = boxMesh(14, [0, 0, 0], [1, 1, 1]);
    a.geometryAabb = shared;
    b.geometryAabb = shared;
    const geom = geometry([a, b]);

    await alignGeometryToReference(geom, georef({ eastings: 2500 }), georef({ eastings: 0 }));

    assertBoxClose(a.geometryAabb, { min: [2500, 0, 0], max: [2501, 1, 1] }, 1e-3, 'submesh a');
    assertBoxClose(b.geometryAabb, { min: [2500, 0, 0], max: [2501, 1, 1] }, 1e-3, 'submesh b');
  });

  it('aligns the instanced-only box channel too', async () => {
    const geom = geometry([boxMesh(15, [0, 0, 0], [1, 1, 1])]);
    geom.instancedGeometryAabbs = new Map<number, EntityWorldAabb>([
      [99, { min: [0, 0, 0], max: [2, 2, 2] }],
    ]);

    await alignGeometryToReference(geom, georef({ eastings: 2500 }), georef({ eastings: 0 }));

    assertBoxClose(
      geom.instancedGeometryAabbs?.get(99),
      { min: [2500, 0, 0], max: [2502, 2, 2] },
      1e-3,
      'instanced',
    );
  });

  it('does not conjure an instanced-only channel that the model never had', async () => {
    // Absent and empty are distinct states downstream: `buildFingerprints`
    // branches on the channel's presence. Alignment re-frames what is there
    // and never invents a channel, which is also what keeps
    // `realignFederation`'s snapshot honest — a model that had no instanced
    // boxes when its snapshot was taken cannot acquire some later and end up
    // with boxes the restore never reaches.
    const absent = geometry([boxMesh(22, [0, 0, 0], [1, 1, 1])]);
    await alignGeometryToReference(absent, georef({ eastings: 2500 }), georef({ eastings: 0 }));
    assert.equal(absent.instancedGeometryAabbs, undefined, 'an absent channel must stay absent');

    const empty = geometry([boxMesh(23, [0, 0, 0], [1, 1, 1])]);
    empty.instancedGeometryAabbs = new Map<number, EntityWorldAabb>();
    await alignGeometryToReference(empty, georef({ eastings: 2500 }), georef({ eastings: 0 }));
    assert.equal(empty.instancedGeometryAabbs?.size, 0, 'an empty channel must stay empty');
  });

  it('leaves an entity that produced no box without one', async () => {
    const mesh = boxMesh(16, [0, 0, 0], [1, 1, 1]);
    delete mesh.geometryAabb;
    const geom = geometry([mesh]);

    await alignGeometryToReference(geom, georef({ eastings: 2500 }), georef({ eastings: 0 }));

    assert.equal(mesh.geometryAabb, undefined);
  });

  it('leaves the caller\'s pre-alignment box untouched, so re-align can restore it', async () => {
    // `realignFederation` snapshots the pre-alignment boxes by REFERENCE and
    // restores them before re-aligning against a new anchor (as it does for
    // positions and normals). That is only sound while alignment replaces box
    // objects instead of mutating them — this pins both halves.
    const mesh = boxMesh(18, [0, 0, 0], [1, 2, 3]);
    const geom = geometry([mesh]);
    const positionSnapshot = new Float32Array(mesh.positions);
    const boxSnapshot = mesh.geometryAabb;
    assert.ok(boxSnapshot);

    await alignGeometryToReference(geom, georef({ eastings: 2500 }), georef({ eastings: 0 }));
    assert.deepEqual(boxSnapshot.min, [0, 0, 0], 'snapshot must not be mutated in place');
    assert.deepEqual(boxSnapshot.max, [1, 2, 3], 'snapshot must not be mutated in place');

    // Restore exactly as realignFederation does, then re-align to a different
    // anchor. A compounding transform would land the box at 2500 + 700.
    mesh.positions = new Float32Array(positionSnapshot);
    mesh.geometryAabb = boxSnapshot;
    geom.coordinateInfo = coordinateInfo();
    await alignGeometryToReference(geom, georef({ eastings: 700 }), georef({ eastings: 0 }));

    assertBoxClose(mesh.geometryAabb, { min: [700, 0, 0], max: [701, 2, 3] }, 1e-3, 're-aligned');
    assertBoxClose(mesh.geometryAabb, worldBoundsOfPositions([mesh], [0, 0, 0]), 1e-3, 're-aligned');
  });

  it('drops the box of an entity only half of which could be reprojected', async () => {
    // proj4 answers `Infinity` — it does not throw — for a point outside the
    // target projection's domain, and it answers per POINT. An outlying vertex
    // therefore stays in the SOURCE frame while its neighbours move, leaving
    // the mesh spanning two coordinate frames. Measuring it would box only the
    // half that moved; corner-transforming it would assert a position for
    // geometry that is not there. Neither is honest, so the box goes and the
    // engine falls back to its documented bare `moved`.
    const corners: number[] = [];
    for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) corners.push(x, y, z);
    const mesh = {
      expressId: 24,
      positions: new Float32Array([...corners, 3e8, 0, 0]),
      normals: new Float32Array(corners.length + 3),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 1, 1, 1],
      geometryHash: 7n,
      geometryAabb: { min: [0, 0, 0], max: [3e8, 1, 1] },
    } as unknown as MeshData;
    const geom = geometry([mesh]);

    const status = await alignGeometryToReference(
      geom,
      georef({ eastings: 500_000, northings: 5_000_000 }, 'EPSG:32632'),
      georef({ eastings: 300_000, northings: 5_000_000 }, 'EPSG:32633'),
    );
    // The alignment itself still succeeds — most vertices moved, and that
    // best-effort behaviour predates the box.
    assert.equal(status, 'reprojected');
    assert.equal(mesh.positions[24], 3e8, 'fixture must actually leave one vertex behind');
    assert.ok(mesh.positions[0] < -1e5, 'fixture must actually reproject the others');

    assert.equal(mesh.geometryAabb, undefined, 'a two-frame mesh must not carry a box');
  });

  it('carries the box across a cross-CRS reprojection', async () => {
    const mesh = boxMesh(17, [0, 0, 0], [1, 1, 1]);
    const geom = geometry([mesh]);

    const status = await alignGeometryToReference(
      geom,
      georef({ eastings: 500_000, northings: 5_000_000 }, 'EPSG:32632'),
      georef({ eastings: 300_000, northings: 5_000_000 }, 'EPSG:32633'),
    );
    assert.equal(status, 'reprojected');

    // A UTM zone hop lands the geometry ~270 km from the origin, where one f32
    // ULP is ~0.03 m. `positions` are f32 and the box is f64, so the box is the
    // MORE precise of the two and the comparison tolerance has to admit the
    // rounding in the positions. The defect this pins is 270 km wide.
    const expected = worldBoundsOfPositions([mesh], [0, 0, 0]);
    assertBoxClose(mesh.geometryAabb, expected, 0.05, 'reprojected');
  });
});
