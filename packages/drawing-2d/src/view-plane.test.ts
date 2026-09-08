/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The SCALE-EXACTNESS invariant for the to-scale 3D-view PDF (issue #2042).
 *
 * Defect class: a page that is dimensionally plausible but geometrically
 * wrong — skewed by a non-orthonormal basis, mirrored (#2119), or with the
 * model pushed behind the synthetic camera plane. An engineer measures off
 * this print, so "1:100" must mean 1 m -> exactly 10 mm, along ANY in-plane
 * direction, from ANY camera orientation.
 *
 * Every fixture here is deliberately OBLIQUE and OFF-ORIGIN:
 *  - azimuth 30 deg / elevation 20 deg, so no basis vector is axis-aligned;
 *  - the measured pair runs along an arbitrary in-plane DIAGONAL, so a basis
 *    that is orthogonal but not unit-length (or unit but not orthogonal)
 *    changes the measured distance;
 *  - the model sits at positive, asymmetric world coordinates, so an
 *    identity/near-identity transform or an offset derived from a frame the
 *    points were never drawn in cannot pass.
 */

import { describe, expect, it } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import {
  buildCameraSectionPlane,
  worldBoundsCorners,
  worldBoundsOfMeshes,
  type CameraFrame,
  type WorldBounds3D,
} from './view-plane.js';
import { computePdfScaleLayout, worldPointToPdfMm } from './pdf-scale.js';
import { projectPointForPlane, signedDepth } from './projection-bands.js';
import {
  boundsEmpty,
  boundsExtendPoint,
  point2DDistance,
  vec3,
  vec3Cross,
  vec3Dot,
  vec3Sub,
} from './math.js';
import type { Bounds2D, Point2D, SectionPlaneConfig, Vec3 } from './types.js';

const DEG = Math.PI / 180;

/** Asymmetric, off-origin model box so nothing can pass by symmetry. */
const TARGET: Vec3 = vec3(37.25, 4.5, -18.75);
const BOUNDS: WorldBounds3D = {
  min: vec3(TARGET.x - 12, TARGET.y - 3, TARGET.z - 9),
  max: vec3(TARGET.x + 8, TARGET.y + 7, TARGET.z + 14),
};

/** Camera orbiting `TARGET` at (azimuth, elevation), distance 40 m. */
function obliqueCamera(azimuthDeg: number, elevationDeg: number, up: Vec3 = vec3(0, 1, 0)): CameraFrame {
  const az = azimuthDeg * DEG;
  const el = elevationDeg * DEG;
  const d = 40;
  return {
    position: vec3(
      TARGET.x + d * Math.cos(el) * Math.cos(az),
      TARGET.y + d * Math.sin(el),
      TARGET.z + d * Math.cos(el) * Math.sin(az),
    ),
    target: TARGET,
    up,
  };
}

/**
 * A UNIT direction lying in the drawing plane, derived WITHOUT touching the
 * basis under test: take an arbitrary vector `w` and strip its component
 * along the view direction (which follows from `position`/`target` alone).
 *
 * Building the measured pair this way is what makes the assertion measure
 * the claim: the fixture cannot inherit a defect from the very basis the
 * test is checking, so a non-orthonormal basis shows up as a wrong
 * millimetre reading rather than as a wrong fixture.
 */
function inPlaneUnit(camera: CameraFrame, w: Vec3): Vec3 {
  const raw = vec3Sub(camera.target, camera.position);
  const len = Math.hypot(raw.x, raw.y, raw.z);
  const v = vec3(raw.x / len, raw.y / len, raw.z / len);
  const k = vec3Dot(w, v);
  const p = vec3(w.x - v.x * k, w.y - v.y * k, w.z - v.z * k);
  const pl = Math.hypot(p.x, p.y, p.z);
  return vec3(p.x / pl, p.y / pl, p.z / pl);
}

function customPlaneOf(plane: SectionPlaneConfig): NonNullable<SectionPlaneConfig['customPlane']> {
  const custom = plane.customPlane;
  if (!custom) throw new Error('expected a custom plane');
  return custom;
}

/** Page layout sized to exactly the points the test is about to draw. */
function layoutFor(points: Point2D[], scaleFactor: number) {
  let bounds: Bounds2D = boundsEmpty();
  for (const p of points) bounds = boundsExtendPoint(bounds, p);
  return computePdfScaleLayout(bounds, scaleFactor, 10);
}

describe('buildCameraSectionPlane — scale exactness', () => {
  /** Millimetres between two world points 1 m apart, printed at 1:`scale`. */
  function printedMmForOneMetre(camera: CameraFrame, w: Vec3, scaleFactor: number): number {
    const { plane } = buildCameraSectionPlane(camera, BOUNDS);
    const dir = inPlaneUnit(camera, w);
    const p0 = TARGET;
    const p1 = vec3(p0.x + dir.x, p0.y + dir.y, p0.z + dir.z);
    // The fixture really is 1 m, independently of the module under test.
    expect(Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z)).toBeCloseTo(1, 12);

    const q0 = projectPointForPlane(p0, plane);
    const q1 = projectPointForPlane(p1, plane);
    const layout = layoutFor([q0, q1], scaleFactor);
    return point2DDistance(
      worldPointToPdfMm(q0, layout.transform),
      worldPointToPdfMm(q1, layout.transform),
    );
  }

  // An arbitrary generator vector: axis-aligned with nothing, so the in-plane
  // direction it produces is a genuine diagonal for every camera below.
  const W = vec3(0.31, -0.87, 0.62);

  it('maps 1 m along an arbitrary in-plane diagonal to exactly 10 mm at 1:100', () => {
    expect(printedMmForOneMetre(obliqueCamera(30, 20), W, 100)).toBeCloseTo(10, 10);
  });

  it('doubles that to exactly 20 mm at 1:50', () => {
    expect(printedMmForOneMetre(obliqueCamera(30, 20), W, 50)).toBeCloseTo(20, 10);
  });

  it('holds for a second, unrelated oblique camera (azimuth 115, elevation -35)', () => {
    expect(printedMmForOneMetre(obliqueCamera(115, -35), W, 100)).toBeCloseTo(10, 10);
  });

  it('holds when the camera `up` is neither unit nor perpendicular to the view', () => {
    // The raw `up` an orbiting camera hands out. Used verbatim as the drawing
    // Y axis it SKEWS the page: 1 m would print as something other than 10 mm.
    const camera = obliqueCamera(30, 20, vec3(0.3, 2.4, -0.7));
    expect(printedMmForOneMetre(camera, W, 100)).toBeCloseTo(10, 10);
    expect(printedMmForOneMetre(camera, vec3(-1.4, 0.2, 0.9), 100)).toBeCloseTo(10, 10);
  });

  it('holds along four different in-plane directions at once', () => {
    const camera = obliqueCamera(30, 20);
    for (const w of [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1), vec3(0.5, 0.5, -0.5)]) {
      expect(printedMmForOneMetre(camera, w, 100)).toBeCloseTo(10, 10);
    }
  });

  it('collapses a 1 m offset ALONG the view direction to 0 mm (parallel projection)', () => {
    const camera = obliqueCamera(30, 20);
    const { plane } = buildCameraSectionPlane(camera, BOUNDS);
    const n = customPlaneOf(plane).normal;
    // normal = -viewDir, so stepping along -normal walks away from the viewer.
    const p1 = vec3(TARGET.x - n.x, TARGET.y - n.y, TARGET.z - n.z);

    const q0 = projectPointForPlane(TARGET, plane);
    const q1 = projectPointForPlane(p1, plane);

    expect(point2DDistance(q0, q1)).toBeCloseTo(0, 12);
    // ...but its VIEW DEPTH grows by exactly 1 m.
    expect(-signedDepth(p1, plane) - -signedDepth(TARGET, plane)).toBeCloseTo(1, 10);
  });
});

describe('buildCameraSectionPlane — handedness (the #2119 mirrored-page class)', () => {
  it('puts a point right of the target right of the page centre, and one above it above', () => {
    const { plane } = buildCameraSectionPlane(obliqueCamera(30, 20), BOUNDS);
    const { tangent, bitangent } = customPlaneOf(plane);

    const right = vec3(TARGET.x + tangent.x * 3, TARGET.y + tangent.y * 3, TARGET.z + tangent.z * 3);
    const above = vec3(
      TARGET.x + bitangent.x * 3,
      TARGET.y + bitangent.y * 3,
      TARGET.z + bitangent.z * 3,
    );

    const qc = projectPointForPlane(TARGET, plane);
    const qr = projectPointForPlane(right, plane);
    const qa = projectPointForPlane(above, plane);
    const layout = layoutFor([qc, qr, qa], 100);

    const mmC = worldPointToPdfMm(qc, layout.transform);
    const mmR = worldPointToPdfMm(qr, layout.transform);
    const mmA = worldPointToPdfMm(qa, layout.transform);

    // Right of centre on the page: larger x, by exactly 3 m at 1:100 = 30 mm.
    expect(mmR.x - mmC.x).toBeCloseTo(30, 10);
    expect(mmR.y).toBeCloseTo(mmC.y, 10);
    // Above centre on the page: PDF y grows DOWNWARD, so smaller y.
    expect(mmA.y - mmC.y).toBeCloseTo(-30, 10);
    expect(mmA.x).toBeCloseTo(mmC.x, 10);
  });

  it('keeps screen-right actually to the right for a world-space +X step in a +Z-looking view', () => {
    // Camera on +Z looking toward -Z with world up: screen right is world +X.
    const camera: CameraFrame = {
      position: vec3(TARGET.x, TARGET.y, TARGET.z + 30),
      target: TARGET,
      up: vec3(0, 1, 0),
    };
    const { plane } = buildCameraSectionPlane(camera, BOUNDS);

    const qc = projectPointForPlane(TARGET, plane);
    const qr = projectPointForPlane(vec3(TARGET.x + 2, TARGET.y, TARGET.z), plane);
    const qu = projectPointForPlane(vec3(TARGET.x, TARGET.y + 2, TARGET.z), plane);
    const layout = layoutFor([qc, qr, qu], 100);

    expect(worldPointToPdfMm(qr, layout.transform).x - worldPointToPdfMm(qc, layout.transform).x)
      .toBeCloseTo(20, 10);
    expect(worldPointToPdfMm(qu, layout.transform).y - worldPointToPdfMm(qc, layout.transform).y)
      .toBeCloseTo(-20, 10);
  });
});

describe('buildCameraSectionPlane — basis', () => {
  it('is orthonormal and right-handed (cross(tangent, bitangent) === normal)', () => {
    // A deliberately non-perpendicular, non-unit `up`: the raw value an
    // orbiting camera hands out. Using it verbatim would skew the page.
    const camera = obliqueCamera(30, 20, vec3(0.3, 2.4, -0.7));
    const { plane } = buildCameraSectionPlane(camera, BOUNDS);
    const { normal, tangent, bitangent } = customPlaneOf(plane);

    for (const v of [normal, tangent, bitangent]) {
      expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1, 12);
    }
    expect(vec3Dot(normal, tangent)).toBeCloseTo(0, 12);
    expect(vec3Dot(normal, bitangent)).toBeCloseTo(0, 12);
    expect(vec3Dot(tangent, bitangent)).toBeCloseTo(0, 12);

    const cross = vec3Cross(tangent, bitangent);
    expect(cross.x).toBeCloseTo(normal.x, 12);
    expect(cross.y).toBeCloseTo(normal.y, 12);
    expect(cross.z).toBeCloseTo(normal.z, 12);
  });

  it('stays orthonormal when `up` is exactly parallel to the view direction', () => {
    // Straight-down camera whose `up` is the view direction itself — the
    // degenerate case that yields a NaN basis (blank PDF) if unguarded.
    const camera: CameraFrame = {
      position: vec3(TARGET.x, TARGET.y + 30, TARGET.z),
      target: TARGET,
      up: vec3(0, -1, 0),
    };
    const { plane } = buildCameraSectionPlane(camera, BOUNDS);
    const { normal, tangent, bitangent } = customPlaneOf(plane);

    for (const v of [normal, tangent, bitangent]) {
      expect(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)).toBe(true);
      expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1, 12);
    }
    expect(vec3Dot(tangent, bitangent)).toBeCloseTo(0, 12);
    expect(vec3Dot(normal, tangent)).toBeCloseTo(0, 12);
    // Still an exact 1 m -> 1 m in-plane projection.
    const p0 = TARGET;
    const p1 = vec3(p0.x + tangent.x * 0.6 + bitangent.x * 0.8,
                    p0.y + tangent.y * 0.6 + bitangent.y * 0.8,
                    p0.z + tangent.z * 0.6 + bitangent.z * 0.8);
    expect(
      point2DDistance(projectPointForPlane(p0, plane), projectPointForPlane(p1, plane)),
    ).toBeCloseTo(1, 12);
  });

  it('treats a LONG, nearly parallel `up` as parallel (the epsilon is an angle, not a length)', () => {
    // `|cross(viewDir, up)|` is `|up| * sin(angle)`. Testing that against a
    // fixed epsilon WITHOUT normalising `up` first makes the threshold scale
    // with `|up|`: this `up` is only 1e-8 rad off the view direction, but its
    // length of 1000 inflates the cross product to ~1e-5, clearing a 1e-6
    // epsilon. The basis is then built from what is numerically noise.
    const camera: CameraFrame = {
      position: vec3(TARGET.x, TARGET.y + 30, TARGET.z),
      target: TARGET,
      up: vec3(1e-8 * 1000, -1000, 0),
    };
    const { plane } = buildCameraSectionPlane(camera, BOUNDS);
    const { normal, tangent, bitangent } = customPlaneOf(plane);

    for (const v of [normal, tangent, bitangent]) {
      expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1, 12);
    }
    expect(vec3Dot(tangent, bitangent)).toBeCloseTo(0, 12);
    expect(vec3Dot(normal, tangent)).toBeCloseTo(0, 12);
    expect(vec3Dot(normal, bitangent)).toBeCloseTo(0, 12);

    // The real payload: the projection stays rigid. A basis derived from the
    // noise direction still passes an orthonormality check (it is normalised
    // after the fact) while measuring wrong, so pin the distance too.
    const p0 = TARGET;
    const p1 = vec3(p0.x + tangent.x * 0.6 + bitangent.x * 0.8,
                    p0.y + tangent.y * 0.6 + bitangent.y * 0.8,
                    p0.z + tangent.z * 0.6 + bitangent.z * 0.8);
    expect(
      point2DDistance(projectPointForPlane(p0, plane), projectPointForPlane(p1, plane)),
    ).toBeCloseTo(1, 12);

    // And it agrees with the same camera expressed with a UNIT up: length must
    // not change the drawing at all.
    const unit = buildCameraSectionPlane(
      { ...camera, up: vec3(1e-8, -1, 0) },
      BOUNDS,
    );
    const unitBasis = customPlaneOf(unit.plane);
    expect(vec3Dot(tangent, unitBasis.tangent)).toBeCloseTo(1, 10);
    expect(vec3Dot(bitangent, unitBasis.bitangent)).toBeCloseTo(1, 10);
  });

  it('throws instead of emitting a NaN transform when eye and target coincide', () => {
    expect(() =>
      buildCameraSectionPlane({ position: TARGET, target: TARGET, up: vec3(0, 1, 0) }, BOUNDS),
    ).toThrow(/view direction/i);
  });
});

describe('buildCameraSectionPlane — plane placement', () => {
  it('sits strictly in front of all 8 bounds corners, with viewDepth covering the full extent', () => {
    const { plane, viewDepth } = buildCameraSectionPlane(obliqueCamera(30, 20), BOUNDS);
    const corners = worldBoundsCorners(BOUNDS);
    expect(corners).toHaveLength(8);

    const depths = corners.map((c) => -signedDepth(c, plane));
    for (const d of depths) {
      expect(d).toBeGreaterThan(0); // in front of the plane = inside the kept half
      expect(d).toBeLessThan(viewDepth); // inside the projection/occluder window
    }

    // viewDepth covers the model's full extent along the view direction.
    const viewDir = vec3(
      -customPlaneOf(plane).normal.x,
      -customPlaneOf(plane).normal.y,
      -customPlaneOf(plane).normal.z,
    );
    const s = corners.map((c) => vec3Dot(c, viewDir));
    const extent = Math.max(...s) - Math.min(...s);
    expect(viewDepth).toBeGreaterThanOrEqual(extent);
    // ...without ballooning: at most a 1% pad over the true extent.
    expect(viewDepth).toBeLessThanOrEqual(extent * 1.01 + 1e-3);
  });

  it('places the plane in front for a camera looking the OTHER way too', () => {
    const { plane, viewDepth } = buildCameraSectionPlane(obliqueCamera(210, -20), BOUNDS);
    for (const c of worldBoundsCorners(BOUNDS)) {
      const d = -signedDepth(c, plane);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThan(viewDepth);
    }
  });

  it('reports the plane offset consistently with its own origin point', () => {
    const { plane } = buildCameraSectionPlane(obliqueCamera(30, 20), BOUNDS);
    const { normal, distance, origin } = customPlaneOf(plane);
    // The basis origin must lie ON the plane, or 2D coordinates and depths
    // would be measured from two different places.
    expect(vec3Dot(origin, normal)).toBeCloseTo(distance, 9);
    expect(plane.flipped).toBe(false);
  });
});

describe('worldBoundsOfMeshes', () => {
  function mesh(positions: number[], origin?: [number, number, number]): MeshData {
    const m: MeshData = {
      expressId: 1,
      ifcType: 'IfcWall',
      modelIndex: 0,
      positions: new Float32Array(positions),
      normals: new Float32Array(positions.length),
      indices: new Uint32Array(positions.map((_, i) => i).slice(0, positions.length / 3)),
      color: [1, 1, 1, 1],
    };
    if (origin) m.origin = origin;
    return m;
  }

  it('folds MeshData.origin into the world box', () => {
    const bounds = worldBoundsOfMeshes([mesh([0, 0, 0, 1, 2, 3], [100, -5, 0.5])]);
    expect(bounds).not.toBeNull();
    expect(bounds?.min).toEqual({ x: 100, y: -5, z: 0.5 });
    expect(bounds?.max).toEqual({ x: 101, y: -3, z: 3.5 });
  });

  it('agrees with a baked-positions twin of the same geometry', () => {
    const local = worldBoundsOfMeshes([mesh([0, 0, 0, 1, 2, 3], [100, -5, 0.5])]);
    const baked = worldBoundsOfMeshes([mesh([100, -5, 0.5, 101, -3, 3.5])]);
    expect(local).toEqual(baked);
  });

  it('unions across meshes and returns null for an empty set', () => {
    const bounds = worldBoundsOfMeshes([
      mesh([0, 0, 0, 1, 1, 1]),
      mesh([-4, 2, 7, -3, 3, 8]),
    ]);
    expect(bounds?.min).toEqual({ x: -4, y: 0, z: 0 });
    expect(bounds?.max).toEqual({ x: 1, y: 3, z: 8 });
    expect(worldBoundsOfMeshes([])).toBeNull();
    expect(worldBoundsOfMeshes([mesh([])])).toBeNull();
  });
});
