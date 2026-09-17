/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import {
  applyModelRotation, baselineIsForeign, captureAppendedMeshBaselines, captureRotationBaseline,
  modelBoundsCentre,
} from './rotation-geometry.js';
import { degreesToRadians, rotateWorkspacePoint, type ModelRotation } from './rotation.js';
import { addTranslation, fromRenderTranslation, type Translation } from './translation.js';

/** 30°, not 90°: at a right angle cos and sin are 0 and 1, so a transposed
 * pair degenerates to the identity and the fixture stops being able to see it.
 * The pivot is off-origin and the shape is asymmetric for the same reason. */
const ANGLE = degreesToRadians(30);
const PIVOT: Translation = [10, 4, 0];
const ROTATION: ModelRotation = { angle: ANGLE, pivot: PIVOT };
/** Off-axis on all three components, so a dropped or swapped term shows. */
const OFFSET: Translation = [7, -3, 2];

type Geometry = Pick<GeometryResult, 'meshes' | 'coordinateInfo' | 'instancedGeometryAabbs'>;

function mesh(): MeshData {
  return {
    expressId: 42,
    // An L, so no reflection or axis swap can reproduce it.
    positions: new Float32Array([0, 0, 0, 3, 0, 0, 3, 0, 1, 0, 2, 1]),
    normals: new Float32Array([1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    origin: [100, 5, -40],
    geometryAabb: { min: [100, 5, -40], max: [103, 7, -39] },
    localToWorld: [1, 0, 0, 100, 0, 1, 0, 5, 0, 0, 1, -40, 0, 0, 0, 1],
  } as MeshData;
}

function geometry(): Geometry {
  return {
    meshes: [mesh()],
    instancedGeometryAabbs: new Map([[99, { min: [1, 0, 2], max: [5, 3, 9] } as const]]),
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 100, y: 5, z: -40 }, max: { x: 103, y: 7, z: -39 } },
      hasLargeCoordinates: false,
    },
  } as unknown as Geometry;
}

/** Every vertex as a WORKSPACE point (engineering Z-up metres), which is the
 * frame the panel's numbers and the pivot are in. */
function worldPoints(value: Geometry): Translation[] {
  const points: Translation[] = [];
  for (const item of value.meshes) {
    const origin = item.origin ?? [0, 0, 0];
    for (let i = 0; i < item.positions.length; i += 3) {
      points.push(fromRenderTranslation({
        x: item.positions[i] + origin[0], y: item.positions[i + 1] + origin[1], z: item.positions[i + 2] + origin[2] }));
    }
  }
  return points;
}

function close(actual: Translation, expected: Translation, what: string): void {
  for (let axis = 0; axis < 3; axis += 1) {
    assert.ok(Math.abs(actual[axis] - expected[axis]) < 1e-3,
      `${what} axis ${axis}: ${actual[axis]} vs ${expected[axis]}`);
  }
}

describe('applyModelRotation', () => {
  it('turns every vertex about the pivot by the stated angle', () => {
    const value = geometry();
    const before = worldPoints(value);
    applyModelRotation(value, captureRotationBaseline(value), ROTATION);
    const after = worldPoints(value);
    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i += 1) {
      // The expectation comes from the ENGINEERING formula while the code works
      // in the renderer's Y-up frame, so a sign error in the axis swap cannot
      // cancel between the two.
      close(after[i], rotateWorkspacePoint(before[i], ROTATION), `vertex ${i}`);
    }
    assert.ok(before.some((point, i) => Math.abs(point[0] - after[i][0]) > 1),
      'the fixture must actually move under this rotation');
  });

  it('rotates about the pivot BEFORE the placement translation', () => {
    const value = geometry();
    const before = worldPoints(value);
    applyModelRotation(value, captureRotationBaseline(value), ROTATION);
    // The renderer adds the placement offset on top of these baked vertices.
    const rotateThenTranslate = worldPoints(value).map((point) => addTranslation(point, OFFSET));
    const translateThenRotate = before.map((point) => rotateWorkspacePoint(addTranslation(point, OFFSET), ROTATION));
    assert.ok(rotateThenTranslate.some((point, i) => Math.abs(point[0] - translateThenRotate[i][0]) > 1e-3),
      'the fixture must be able to tell the two orders apart');
    for (let i = 0; i < before.length; i += 1) {
      close(rotateThenTranslate[i], addTranslation(rotateWorkspacePoint(before[i], ROTATION), OFFSET), `ordered vertex ${i}`);
    }
  });

  it('rotates normals so lighting follows the model', () => {
    const value = geometry();
    applyModelRotation(value, captureRotationBaseline(value), ROTATION);
    const normals = value.meshes[0].normals!;
    // Renderer +X normal under a yaw of `angle` about +Y.
    assert.ok(Math.abs(normals[0] - Math.cos(ANGLE)) < 1e-6, `normal x ${normals[0]}`);
    assert.ok(Math.abs(normals[2] + Math.sin(ANGLE)) < 1e-6, `normal z ${normals[2]}`);
    assert.ok(Math.abs(Math.hypot(normals[0], normals[1], normals[2]) - 1) < 1e-6, 'normal stays unit length');
  });

  it('re-derives an entity box from all eight corners, never from min/max', () => {
    const value = geometry();
    const source = value.meshes[0].geometryAabb!;
    applyModelRotation(value, captureRotationBaseline(value), ROTATION);
    const box = value.meshes[0].geometryAabb!;
    // Translating min/max would keep the box's width; a 30° turn cannot.
    assert.ok(box.max[0] - box.min[0] > (source.max[0] - source.min[0]) + 1e-3,
      `rotated box X span ${box.max[0] - box.min[0]} did not widen from ${source.max[0] - source.min[0]}`);
    // Every rotated source corner must be inside the new box.
    for (const x of [source.min[0], source.max[0]]) {
      for (const z of [source.min[2], source.max[2]]) {
        const point = rotateWorkspacePoint(fromRenderTranslation({ x, y: source.min[1], z }), ROTATION);
        const corner = [point[0], source.min[1], -point[1]];
        for (let axis = 0; axis < 3; axis += 1) {
          assert.ok(corner[axis] >= box.min[axis] - 1e-3 && corner[axis] <= box.max[axis] + 1e-3,
            `corner axis ${axis} = ${corner[axis]} outside [${box.min[axis]}, ${box.max[axis]}]`);
        }
      }
    }
    // A vertical-axis turn cannot change the elevation span.
    assert.ok(Math.abs(box.min[1] - source.min[1]) < 1e-6 && Math.abs(box.max[1] - source.max[1]) < 1e-6,
      'elevation span changed under a vertical-axis rotation');
  });

  it('corner-transforms the instanced-only boxes, which have no vertices to measure', () => {
    const value = geometry();
    const source = value.instancedGeometryAabbs!.get(99)!;
    applyModelRotation(value, captureRotationBaseline(value), ROTATION);
    const box = value.instancedGeometryAabbs!.get(99)!;
    assert.ok(box.max[0] - box.min[0] > (source.max[0] - source.min[0]) + 1e-3, 'instanced box did not re-derive');
    assert.ok(Math.abs(box.min[1] - source.min[1]) < 1e-6, 'instanced box elevation moved');
  });

  it('turns the ABSOLUTE world boxes about the same axis as the vertices on an origin-shifted model', () => {
    // `geometryAabb` and the instanced boxes carry the RTC offset and the origin
    // shift folded in; positions and the pivot do not. Off-axis values on every
    // component, so a dropped or swapped term cannot cancel.
    const value = geometry();
    value.coordinateInfo.originShift = { x: 2_000.25, y: 30.5, z: -1_500.75 };
    (value.coordinateInfo as { wasmRtcOffset?: { x: number; y: number; z: number } }).wasmRtcOffset = { x: 400_000.5, y: 5_000_000.25, z: 12.5 };
    const offset = [2_000.25 + 400_000.5, 30.5 + 12.5, -1_500.75 - 5_000_000.25];
    const absolute = (box: { min: number[]; max: number[] }) => ({
      min: box.min.map((v, axis) => v + offset[axis]) as [number, number, number],
      max: box.max.map((v, axis) => v + offset[axis]) as [number, number, number] });
    value.meshes[0].geometryAabb = absolute(value.meshes[0].geometryAabb!);
    // An instanced entity whose extent is these render-frame points.
    const instancedPoints: Translation[] = [[20, 1, -7], [23.5, 4, -2.25]];
    value.instancedGeometryAabbs = new Map([[99, absolute({ min: [20, 1, -7], max: [23.5, 4, -2.25] })]]);

    applyModelRotation(value, captureRotationBaseline(value), ROTATION);

    const inside = (point: number[], box: { min: number[]; max: number[] }, what: string) => {
      for (let axis = 0; axis < 3; axis += 1) {
        const world = point[axis] + offset[axis];
        assert.ok(world >= box.min[axis] - 1e-3 && world <= box.max[axis] + 1e-3,
          `${what} axis ${axis}: ${world} outside [${box.min[axis]}, ${box.max[axis]}]`);
      }
    };
    // Render-frame vertices, rotated by the code under test.
    for (const point of worldPoints(value)) {
      inside([point[0], point[2], -point[1]], value.meshes[0].geometryAabb!, 'rotated vertex');
    }
    // Render-frame instanced extent, rotated independently in engineering axes.
    for (const x of [instancedPoints[0][0], instancedPoints[1][0]]) {
      for (const z of [instancedPoints[0][2], instancedPoints[1][2]]) {
        const turned = rotateWorkspacePoint(fromRenderTranslation({ x, y: 1, z }), ROTATION);
        inside([turned[0], turned[2], -turned[1]], value.instancedGeometryAabbs!.get(99)!, 'rotated instanced corner');
      }
    }
  });

  it('carries the rotation into localToWorld so placement-reading paths agree', () => {
    const value = geometry();
    const matrix = [...value.meshes[0].localToWorld!];
    applyModelRotation(value, captureRotationBaseline(value), ROTATION);
    const next = value.meshes[0].localToWorld!;
    assert.ok(Math.abs(next[0] - Math.cos(ANGLE)) < 1e-6, `m00 ${next[0]}`);
    assert.ok(Math.abs(next[2] - Math.sin(ANGLE)) < 1e-6, `m02 ${next[2]}`);
    assert.ok(Math.abs(next[8] + Math.sin(ANGLE)) < 1e-6, `m20 ${next[8]}`);
    assert.ok(Math.abs(next[5] - 1) < 1e-6, 'the vertical row must not turn');
    // The translation column is the origin, and must land where the origin did.
    close(fromRenderTranslation({ x: next[3], y: next[7], z: next[11] }),
      rotateWorkspacePoint(fromRenderTranslation({ x: matrix[3], y: matrix[7], z: matrix[11] }), ROTATION), 'localToWorld translation');
  });

  it('re-measures the shifted bounds from the rotated vertices', () => {
    const value = geometry();
    const before = { ...value.coordinateInfo.shiftedBounds! };
    applyModelRotation(value, captureRotationBaseline(value), ROTATION);
    const bounds = value.coordinateInfo.shiftedBounds!;
    assert.ok(Math.abs(bounds.min.x - before.min.x) > 1e-3 || Math.abs(bounds.max.x - before.max.x) > 1e-3,
      'the bounds were left describing the un-rotated geometry');
    for (const point of worldPoints(value)) {
      assert.ok(point[0] >= bounds.min.x - 1e-3 && point[0] <= bounds.max.x + 1e-3, `x ${point[0]} outside bounds`);
      assert.ok(point[2] >= bounds.min.y - 1e-3 && point[2] <= bounds.max.y + 1e-3, `z ${point[2]} outside bounds`);
    }
  });

  it('keeps instanced-only entities and released meshes inside the rotated shifted bounds', () => {
    const value = geometry();
    const shift = { x: 31.5, y: -2.25, z: 17.75 };
    value.coordinateInfo.originShift = shift;
    // Render-frame extents, stored absolute as the contract requires.
    const instancedExtent = { min: [1, 0, 2], max: [5, 3, 9] };
    value.instancedGeometryAabbs = new Map([[99, {
      min: [1 + shift.x, 0 + shift.y, 2 + shift.z], max: [5 + shift.x, 3 + shift.y, 9 + shift.z] }]]);
    const released = { ...mesh(), expressId: 43, positions: new Float32Array(0), normals: new Float32Array(0),
      origin: [60, 0, 20], geometryAabb: { min: [60 + shift.x, 0 + shift.y, 20 + shift.z], max: [64 + shift.x, 2 + shift.y, 25 + shift.z] } } as MeshData;
    value.meshes.push(released);
    const releasedExtent = { min: [60, 0, 20], max: [64, 2, 25] };

    applyModelRotation(value, captureRotationBaseline(value), ROTATION);

    const bounds = value.coordinateInfo.shiftedBounds!;
    for (const [what, extent] of [['instanced', instancedExtent], ['released', releasedExtent]] as const) {
      for (const x of [extent.min[0], extent.max[0]]) {
        for (const z of [extent.min[2], extent.max[2]]) {
          const turned = rotateWorkspacePoint(fromRenderTranslation({ x, y: extent.min[1], z }), ROTATION);
          assert.ok(turned[0] >= bounds.min.x - 1e-3 && turned[0] <= bounds.max.x + 1e-3,
            `${what} corner x ${turned[0]} outside [${bounds.min.x}, ${bounds.max.x}]`);
          assert.ok(-turned[1] >= bounds.min.z - 1e-3 && -turned[1] <= bounds.max.z + 1e-3,
            `${what} corner z ${-turned[1]} outside [${bounds.min.z}, ${bounds.max.z}]`);
        }
      }
    }
  });

  it('is absolute: re-applying an angle re-bakes rather than compounding', () => {
    const once = geometry();
    const baselineOnce = captureRotationBaseline(once);
    applyModelRotation(once, baselineOnce, ROTATION);
    const expected = worldPoints(once);

    const twice = geometry();
    const baselineTwice = captureRotationBaseline(twice);
    applyModelRotation(twice, baselineTwice, ROTATION);
    applyModelRotation(twice, baselineTwice, ROTATION);
    const actual = worldPoints(twice);
    for (let i = 0; i < expected.length; i += 1) close(actual[i], expected[i], `re-applied vertex ${i}`);
  });

  it('restores the pristine geometry at zero', () => {
    const value = geometry();
    const baseline = captureRotationBaseline(value);
    const before = worldPoints(value);
    const matrix = [...value.meshes[0].localToWorld!];
    const box = value.meshes[0].geometryAabb!;
    applyModelRotation(value, baseline, ROTATION);
    applyModelRotation(value, baseline, { angle: 0, pivot: PIVOT });
    const after = worldPoints(value);
    for (let i = 0; i < before.length; i += 1) close(after[i], before[i], `restored vertex ${i}`);
    assert.deepEqual(value.meshes[0].localToWorld, matrix);
    assert.deepEqual(value.meshes[0].geometryAabb, box);
    assert.deepEqual(value.instancedGeometryAabbs?.get(99), { min: [1, 0, 2], max: [5, 3, 9] });
  });

  it('keeps vertex coordinates local rather than folding the pivot into them', () => {
    const value = geometry();
    applyModelRotation(value, captureRotationBaseline(value), { angle: ANGLE, pivot: [500_000, 200_000, 0] });
    for (const position of value.meshes[0].positions) {
      assert.ok(Math.abs(position) < 100, `vertex coordinate ${position} grew to pivot scale`);
    }
  });

  it('does not invent an origin for a mesh that never had one', () => {
    const value = geometry();
    delete value.meshes[0].origin;
    const before = worldPoints(value);
    applyModelRotation(value, captureRotationBaseline(value), ROTATION);
    assert.equal(value.meshes[0].origin, undefined);
    const after = worldPoints(value);
    for (let i = 0; i < before.length; i += 1) close(after[i], rotateWorkspacePoint(before[i], ROTATION), `absolute vertex ${i}`);
  });
});

describe('baselineIsForeign', () => {
  it('is foreign only when the baseline describes none of the meshes', () => {
    const value = geometry();
    const known = value.meshes[0];
    const baseline = captureRotationBaseline(value);
    assert.equal(baselineIsForeign(value, baseline), false, 'the geometry it was captured from');
    // Partial overlap: streaming republishes an array that still holds the
    // baselined mesh alongside a newcomer. Dropping the baseline here would
    // throw away the only pristine copy of the surviving mesh's bytes, and the
    // next bake would compound on top of the angle already in them.
    assert.equal(baselineIsForeign({ ...value, meshes: [known, mesh()] } as Geometry, baseline), false,
      'a baseline that still describes one of the meshes was called foreign');
    // No mesh in common: a replacement, and the baseline can restore nothing.
    assert.equal(baselineIsForeign({ ...value, meshes: [mesh(), mesh()] } as Geometry, baseline), true,
      'a baseline that describes none of the meshes was not called foreign');
  });
});

describe('captureAppendedMeshBaselines', () => {
  it('grows the pristine shifted bounds by an instanced box that arrives after the first bake', () => {
    // Streaming completion republishes the accumulated instanced-only boxes
    // after the model has already been baked. Only appended MESHES used to
    // grow the pristine bounds, so a late box outside the first bake's extent
    // was lost the moment the heading went back to zero.
    const value = geometry();
    const shift = { x: 31.5, y: -2.25, z: 17.75 };
    value.coordinateInfo.originShift = shift;
    // Render-frame extents, stored absolute as the contract requires.
    const absolute = (box: { min: number[]; max: number[] }) => ({
      min: [box.min[0] + shift.x, box.min[1] + shift.y, box.min[2] + shift.z] as [number, number, number],
      max: [box.max[0] + shift.x, box.max[1] + shift.y, box.max[2] + shift.z] as [number, number, number] });
    value.instancedGeometryAabbs = new Map([[99, absolute({ min: [101, 5, -40], max: [102, 6, -39] })]]);
    const baseline = captureRotationBaseline(value);
    applyModelRotation(value, baseline, ROTATION);

    const lateExtent = { min: [400, 50, -300], max: [430, 62, -280] };
    value.instancedGeometryAabbs = new Map([...baseline.instancedGeometryAabbs!, [100, absolute(lateExtent)]]);
    assert.equal(captureAppendedMeshBaselines(value, baseline), true, 'the late boxes were not adopted');

    // Back to zero: `restore` clones the pristine bounds and the zero-angle
    // branch returns without re-measuring, so those bounds are the answer
    // `modelBoundsCentre` and the section calculations get.
    applyModelRotation(value, baseline, { angle: 0, pivot: PIVOT });
    const bounds = value.coordinateInfo.shiftedBounds!;
    const axes = ['x', 'y', 'z'] as const;
    for (let axis = 0; axis < 3; axis += 1) {
      const key = axes[axis];
      assert.ok(bounds.min[key] <= lateExtent.min[axis] + 1e-3,
        `late instanced box min ${key} ${lateExtent.min[axis]} outside pristine bounds min ${bounds.min[key]}`);
      assert.ok(bounds.max[key] >= lateExtent.max[axis] - 1e-3,
        `late instanced box max ${key} ${lateExtent.max[axis]} outside pristine bounds max ${bounds.max[key]}`);
    }
  });
});

describe('modelBoundsCentre', () => {
  it('reports the bounding-box centre in workspace engineering metres', () => {
    const centre = modelBoundsCentre(geometry());
    assert.deepEqual(centre, [101.5, 39.5, 6]);
  });

  it('returns null when the bounds are not measurable', () => {
    const value = geometry();
    value.coordinateInfo.shiftedBounds = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
    assert.equal(modelBoundsCentre(value), null);
  });
});
