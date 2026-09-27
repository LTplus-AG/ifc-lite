/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EdgeLockInput, SnapTarget } from '@ifc-lite/renderer';
import type { SnapCandidate, Vec2 } from '../types.js';
import { createMeshSource, type EdgeLockPort, type MeshPick } from './mesh.js';
import { query } from '@/test/snap-fixture.js';

type V = { x: number; y: number; z: number };
const v = (x: number, y: number, z: number): V => ({ x, y, z });
/** Render Y-up → plan (x, -z), elevation y: the storey-workplane mapping at elevation 0. */
const toLocal = (p: V) => ({ local: [p.x, 0 - p.z] as Vec2, elevation: p.y }); // `0 - z`: no -0

const noLock = (): MeshPick['edgeLock'] => ({
  edge: null, meshExpressId: null, edgeT: 0, shouldLock: false, shouldRelease: false, isCorner: false, cornerValence: 0,
});

function recordingLock(): EdgeLockPort & { calls: string[]; state: EdgeLockInput } {
  const port = {
    calls: [] as string[],
    state: { edge: null, meshExpressId: null, lockStrength: 0 } as EdgeLockInput,
    get: () => port.state,
    set: (edge: { v0: V; v1: V }, id: number, t: number) => {
      port.calls.push(`set:${id}:${t}`);
      port.state = { edge, meshExpressId: id, lockStrength: 1 };
    },
    clear: () => {
      port.calls.push('clear');
      port.state = { edge: null, meshExpressId: null, lockStrength: 0 };
    },
  };
  return port;
}

const target = (type: string, position: V, expressId = 7, vertices?: V[]): SnapTarget =>
  ({ type, position, expressId, confidence: 1, metadata: vertices ? { vertices } : undefined }) as SnapTarget;

describe('createMeshSource (#6232 WP3)', () => {
  it('feeds the held lock to the raycast and applies lock / release like pickMeasurePoint', () => {
    const lock = recordingLock();
    const seen: EdgeLockInput[] = [];
    const edge = { v0: v(0, 0, 0), v1: v(4, 0, 0) };
    const picks: MeshPick[] = [
      { snapTarget: null, intersection: null, edgeLock: { ...noLock(), edge, meshExpressId: 7, edgeT: 0.25, shouldLock: true } },
      { snapTarget: null, intersection: null, edgeLock: noLock() },
      { snapTarget: null, intersection: null, edgeLock: { ...noLock(), shouldRelease: true } },
    ];
    const src = createMeshSource({ pick: (l) => { seen.push(l); return picks.shift() ?? null; }, lock, toLocal });
    for (let i = 0; i < 3; i++) src.collect(query([0, 0]), 1, []);
    assert.deepEqual(lock.calls, ['set:7:0.25', 'clear']);
    assert.equal(seen[1].meshExpressId, 7, 'the lock set on move 1 is fed into move 2');
    assert.equal(seen[2].meshExpressId, 7);
  });

  it('turns an edge snap into an edge on its segment plus both ends and the midpoint', () => {
    const edge = { v0: v(0, 0, 0), v1: v(4, 0, -2) };
    const pick: MeshPick = {
      snapTarget: target('edge', v(2, 0, -1)), intersection: { point: v(2, 0, -1), expressId: 7 },
      edgeLock: { ...noLock(), edge, meshExpressId: 7, shouldLock: true },
    };
    const out: SnapCandidate[] = [];
    createMeshSource({ pick: () => pick, lock: recordingLock(), toLocal, entityOf: (id) => ({ modelId: 'm', expressId: id - 1 }) })
      .collect(query([2, 1]), 1, out);
    assert.deepEqual(out.map((c) => c.kind), ['edge', 'endpoint', 'endpoint', 'midpoint', 'face']);
    assert.deepEqual(out[0].guide, { kind: 'segment', a: [0, 0], b: [4, 2], role: 'edge' });
    assert.deepEqual(out[3].local, [2, 1]);
    assert.deepEqual(out[0].entity, { modelId: 'm', expressId: 6 });
  });

  it('a vertical edge (a point in plan) gives one endpoint and no guide', () => {
    const vertical = [v(1, 0, -1), v(1, 3, -1)];
    const pick: MeshPick = { snapTarget: target('edge', v(1, 1.5, -1), 7, vertical), intersection: null, edgeLock: noLock() };
    const out: SnapCandidate[] = [];
    createMeshSource({ pick: () => pick, lock: recordingLock(), toLocal }).collect(query([1, 1]), 1, out);
    assert.deepEqual(out.map((c) => [c.kind, c.guide]), [['edge', undefined], ['endpoint', undefined]]);
  });

  it('maps vertex / face / face-centre / point-cloud targets and skips unmappable points', () => {
    const kinds = ['vertex', 'face', 'face_center', 'point_cloud'].map((type) => {
      const out: SnapCandidate[] = [];
      const pick: MeshPick = { snapTarget: target(type, v(1, 2, -3)), intersection: null, edgeLock: noLock() };
      createMeshSource({ pick: () => pick, lock: recordingLock(), toLocal }).collect(query([0, 0]), 1, out);
      return out.map((c) => `${c.kind}@${c.local.join(',')}^${c.elevation}`);
    });
    assert.deepEqual(kinds, [['vertex@1,3^2'], ['face@1,3^2'], ['face@1,3^2'], ['vertex@1,3^2']]);
    const out: SnapCandidate[] = [];
    const pick: MeshPick = { snapTarget: target('vertex', v(1, 2, -3)), intersection: { point: v(0, 0, 0), expressId: 1 }, edgeLock: noLock() };
    const src = createMeshSource({ pick: () => pick, lock: recordingLock(), toLocal: () => null });
    src.collect(query([0, 0]), 1, out);
    assert.equal(out.length, 0);
    assert.equal(src.lastPick(), pick);
  });
});
