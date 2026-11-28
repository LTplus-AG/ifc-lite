/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A processed model's shared shapes, drawn instanced, must land on exactly the
 * vertices the flat path drew. The check runs the renderer's own instancing
 * math (`decodeInstancedShard` → `prepareInstancedRender`, the matrices the
 * GPU receives) against the flat mesh `occurrenceMesh` produces for the same
 * row, which is the mesh the viewer drew before.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeInstancedShard } from '@ifc-lite/geometry';
import type { SharedShape, SharedShapeOccurrence } from '@ifc-lite/server-client';
import { prepareInstancedRender } from '../../../../packages/renderer/src/instanced-render.js';
import { createEmptyBounds, updateBoundsFromPositions } from './localParsingUtils.js';
import {
  encodeSharedShapeShard,
  growBySharedShapes,
  INSTANCE_MIN_OCCURRENCES,
  instancedOnlyAabbs,
  occurrenceMesh,
  SharedShapeRouting,
} from './serverInstancing.js';

const cos = Math.cos(0.6), sin = Math.sin(0.6);
const YAW = [cos, -sin, 0, sin, cos, 0, 0, 0, 1];
const TILT = [1, 0, 0, 0, cos, -sin, 0, sin, cos];

function shape(occurrences: SharedShapeOccurrence[], over: Partial<SharedShape> = {}): SharedShape {
  return {
    vertex_start: 36, index_start: 60, stream_wide: true,
    // An L-ish prism corner: not symmetric, so a wrong axis shows.
    positions: new Float32Array([0, 0, 0, 2, 0, 0, 2, 0.5, 0, 0, 0.5, 3, 0.25, 1, 0.75]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0.6, 0.8, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 1, 4, 2]),
    occurrences,
    ...over,
  };
}

const occ = (id: number, origin: [number, number, number], rotation?: number[], extra: Partial<SharedShapeOccurrence> = {}): SharedShapeOccurrence => ({
  express_id: id, ifc_type: 'IfcColumn', color: [0.8, 0.7, 0.6, 1], origin, ...(rotation ? { rotation } : {}), ...extra,
});

/** World vertices each prepared instance record draws: `M · p` with the f64 anchor, as `materializeInstances` reads it. */
function drawnWorld(shards: ArrayBuffer[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const bytes of shards) {
    for (const t of prepareInstancedRender(decodeInstancedShard(bytes))) {
      const dv = new DataView(t.instanceBuffer);
      for (let i = 0; i < t.instanceCount; i++) {
        const b = i * (t.instanceBuffer.byteLength / t.instanceCount);
        const m = Array.from({ length: 12 }, (_, k) => dv.getFloat32(b + k * 4, true));
        const a = t.canonicalAnchors.subarray(i * 3, i * 3 + 3);
        const verts: number[] = [];
        for (let v = 0; v < t.positions.length; v += 3) {
          const [x, y, z] = [t.positions[v], t.positions[v + 1], t.positions[v + 2]];
          verts.push(m[0] * x + m[4] * y + m[8] * z + a[0], m[1] * x + m[5] * y + m[9] * z + a[1], m[2] * x + m[6] * y + m[10] * z + a[2]);
        }
        out.set(t.entityIds[i], verts);
      }
    }
  }
  return out;
}

function flatWorld(s: SharedShape, o: SharedShapeOccurrence): number[] {
  const mesh = occurrenceMesh(s, o);
  const origin = mesh.origin ?? [0, 0, 0];
  return Array.from(mesh.positions, (v, i) => v + origin[i % 3]);
}

test('instanced occurrences draw the flat path\'s vertices, rotated or not', () => {
  const occurrences = [
    occ(1, [10, 0, -4]),
    occ(2, [-25.5, 3.25, 40], YAW, { geometry_item_id: 91 }),
    occ(3, [300.125, -12, 7.5], TILT, { metallic: 0.2, roughness: 0 }),
    occ(4, [0, 0, 0], YAW),
  ];
  const s = shape(occurrences);
  const shard = encodeSharedShapeShard([s]);
  assert.ok(shard);
  const drawn = drawnWorld([shard]);
  assert.equal(drawn.size, 4);
  for (const o of occurrences) {
    const want = flatWorld(s, o);
    const got = drawn.get(o.express_id)!;
    assert.equal(got.length, want.length);
    // f32 matrix coefficients against the flat path's f32 positions: sub-0.1 mm at these offsets.
    got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-4, `#${o.express_id} coordinate ${i}: ${v} vs ${want[i]}`));
  }
  const decoded = decodeInstancedShard(shard);
  assert.deepEqual(decoded.instances.map((i) => [i.entityId, i.itemId, i.metallic, i.roughness]),
    [[1, undefined, undefined, undefined], [2, 91, undefined, undefined], [3, undefined, decoded.instances[2].metallic, 0], [4, undefined, undefined, undefined]]);
  assert.ok(Math.abs(decoded.instances[2].metallic! - 0.2) < 1e-6);
  assert.deepEqual(decoded.templateKeys, ['37:60'], 'a stream-wide shape joins its records model-wide');
  assert.equal(decodeInstancedShard(encodeSharedShapeShard([shape(occurrences, { stream_wide: false })])!).templateKeys, undefined);
});

test('the bounds and per-entity boxes match the flat path\'s', () => {
  const occurrences = [occ(1, [10, 0, -4]), occ(2, [-25.5, 3.25, 40], YAW), occ(2, [5, 5, 5], TILT)];
  const s = shape(occurrences);
  const want = createEmptyBounds();
  for (const o of occurrences) {
    const m = occurrenceMesh(s, o);
    updateBoundsFromPositions(want, m.positions, undefined, m.origin ?? null);
  }
  const got = createEmptyBounds();
  const boxes = new Map();
  growBySharedShapes(got, [s], boxes);
  for (const axis of ['x', 'y', 'z'] as const) {
    assert.ok(Math.abs(got.min[axis] - want.min[axis]) < 1e-9 && Math.abs(got.max[axis] - want.max[axis]) < 1e-9, axis);
  }
  const aabbs = instancedOnlyAabbs(boxes, new Set([1]), { x: 100, y: 0, z: -50 });
  assert.deepEqual([...aabbs!.keys()], [2], 'an entity with a flat mesh is enumerated through it already');
  const box2 = boxes.get(2);
  assert.deepEqual(aabbs!.get(2), { min: [box2.min[0] + 100, box2.min[1], box2.min[2] - 50], max: [box2.max[0] + 100, box2.max[1], box2.max[2] - 50] });
});

test('routing instances only what the local partition would: opaque, unclassed, repeated enough', () => {
  const routing = new SharedShapeRouting();
  const few = Array.from({ length: INSTANCE_MIN_OCCURRENCES - 3 }, (_, i) => occ(i + 1, [i, 0, 0]));
  // Below the gate: flat, but counted.
  let { instanced, flat } = routing.split([shape(few)]);
  assert.equal(instanced.length, 0);
  assert.equal(flat.length, few.length);
  // A later batch of the same stream-wide shape crosses the gate: its candidates go instanced.
  const more = [occ(20, [0, 1, 0]), occ(21, [0, 2, 0]), occ(22, [0, 3, 0]),
    occ(23, [0, 4, 0], undefined, { color: [1, 1, 1, 0.5] }), occ(24, [0, 5, 0], undefined, { ifc_type: 'IfcSpace' })];
  ({ instanced, flat } = routing.split([shape(more)]));
  assert.deepEqual(instanced.flatMap((s) => s.occurrences.map((o) => o.express_id)), [20, 21, 22]);
  assert.deepEqual(flat.map((m) => m.express_id), [23, 24], 'transparent and class-toggled occurrences stay flat');
  // A batch-local shape is judged on its own batch.
  ({ instanced } = routing.split([shape(few, { stream_wide: false })]));
  assert.equal(instanced.length, 0);
});

test('a flat fallback mesh equals the decoder\'s own flat mesh for the row', () => {
  const s = shape([]);
  const mesh = occurrenceMesh(s, occ(7, [0, 0, 0], undefined, { geometry_item_id: 5 }));
  assert.equal(mesh.origin, undefined, 'a zero origin is omitted, as transformFields omits it');
  assert.deepEqual(Array.from(mesh.positions), Array.from(s.positions));
  assert.notEqual(mesh.positions, s.positions, 'the block is copied, never aliased');
  assert.equal(mesh.geometry_item_id, 5);
});
