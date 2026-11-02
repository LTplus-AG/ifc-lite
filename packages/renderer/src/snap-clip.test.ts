/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import type { PickClipState } from './pick-types.js';
import { Raycaster, type Ray } from './raycaster.js';
import { SnapDetector, SnapType } from './snap-detector.js';

/**
 * #8659. A 2 x 2 x 2 box [0,2]^3, viewed from above along -z with the section
 * removing z > 1, so the kept part is z <= 1 and the cut contour is the square
 * x, y in [0,2] at z = 1.
 */
const CUBE_INDICES = new Uint32Array([
  0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 5, 1, 0, 4, 5,
  3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
]);

function box(expressId = 7, origin?: [number, number, number]): MeshData {
  const positions = new Float32Array([
    0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0,
    0, 0, 2, 2, 0, 2, 2, 2, 2, 0, 2, 2,
  ]);
  return {
    expressId, positions, normals: new Float32Array(positions.length),
    indices: CUBE_INDICES, color: [0.5, 0.5, 0.5, 1], origin,
  };
}

const NO_LOCK = { edge: null, meshExpressId: null, lockStrength: 0 };
const CAMERA = { position: { x: 1, y: 1, z: 50 }, fov: Math.PI / 4 };
const OPTIONS = { snapToVertices: true, snapToEdges: true, snapToFaces: true, screenSnapRadius: 10 };
const down = (x: number, y: number): Ray => ({ origin: { x, y, z: 50 }, direction: { x: 0, y: 0, z: -1 } });
const section = (distance: number): PickClipState => ({ sectionPlane: { normal: [0, 0, 1], distance, flipped: false } });

/** The magnetic pick the engine runs: the clipped ray, then the snap. */
function pick(detector: SnapDetector, mesh: MeshData, ray: Ray, clip?: PickClipState | null, lock = NO_LOCK, options = OPTIONS) {
  const intersection = new Raycaster().raycast(ray, [mesh], (hit) => {
    if (!clip?.sectionPlane) return true;
    return hit.point.z <= clip.sectionPlane.distance;
  });
  assert.ok(intersection, 'the ray hits the box');
  return { intersection, ...detector.detectMagneticSnap(ray, [mesh], intersection, CAMERA, 800, lock, options, clip) };
}

describe('magnetic snap under a section (#8659)', () => {
  it('looking into the cut solid, the visible inside stays the hit but the rim is reachable from straight above', () => {
    const { intersection, snapTarget } = pick(new SnapDetector(), box(), down(1, 0.2), section(1));
    assert.equal(intersection.point.z, 0, 'no cap is drawn under a magnetic pick, so the inside surface is what shows');
    assert.equal(snapTarget?.type, SnapType.EDGE);
    assert.ok(Math.abs(snapTarget!.position.z - 1) < 1e-6, 'the contour, measured from where the ray crossed the plane');
    assert.ok(Math.abs(snapTarget!.position.y) < 1e-6);
  });

  it('far from the rim, a ray into the cut solid keeps the inside surface', () => {
    const options = { ...OPTIONS, screenSnapRadius: 0.2 };
    const { snapTarget } = pick(new SnapDetector(), box(), down(1, 1), section(1), NO_LOCK, options);
    assert.equal(snapTarget?.position.z, 0);
  });

  it('snaps to the cut contour, sliding along it', () => {
    const { snapTarget, edgeLock } = pick(new SnapDetector(), box(), down(1, 0.05), section(1));
    assert.equal(snapTarget?.type, SnapType.EDGE);
    assert.ok(Math.abs(snapTarget!.position.x - 1) < 1e-6);
    assert.ok(Math.abs(snapTarget!.position.y) < 1e-6);
    assert.ok(Math.abs(snapTarget!.position.z - 1) < 1e-6);
    assert.equal(edgeLock.shouldLock, true);
    const edge = edgeLock.edge!;
    assert.deepEqual([edge.v0.z, edge.v1.z], [1, 1]);
    assert.ok(Math.abs(Math.abs(edge.v1.x - edge.v0.x) - 2) < 1e-6, 'one contour edge of the full 2 m, not a triangle-sized fragment');
  });

  it('snaps to a contour corner', () => {
    const { snapTarget } = pick(new SnapDetector(), box(), down(0.02, 0.02), section(1));
    assert.equal(snapTarget?.type, SnapType.VERTEX);
    assert.deepEqual([snapTarget!.position.x, snapTarget!.position.y, snapTarget!.position.z], [0, 0, 1]);
  });

  it('never reports a point the section removed', () => {
    const detector = new SnapDetector();
    for (let x = 0.1; x < 2; x += 0.3) {
      for (let y = 0.1; y < 2; y += 0.3) {
        const { snapTarget } = pick(detector, box(), down(x, y), section(1));
        assert.ok(snapTarget, `a target at ${x},${y}`);
        assert.ok(snapTarget.position.z <= 1 + 1e-6, `snapped to z=${snapTarget.position.z} at ${x},${y}`);
      }
    }
  });

  it('trims a crossing edge at the plane, keeping its visible part', () => {
    // A side-on ray at the kept part of the vertical edge x=0, y=0.
    const ray: Ray = { origin: { x: -50, y: 0.02, z: 0.5 }, direction: { x: 1, y: 0, z: 0 } };
    const camera = { position: ray.origin, fov: Math.PI / 4 };
    const mesh = box();
    const clip = section(1);
    const surface = new Raycaster().raycast(ray, [mesh]);
    assert.ok(surface);
    const { snapTarget, edgeLock } = new SnapDetector().detectMagneticSnap(ray, [mesh], surface, camera, 800, NO_LOCK, OPTIONS, clip);
    assert.equal(snapTarget?.type, SnapType.EDGE);
    const z = [edgeLock.edge!.v0.z, edgeLock.edge!.v1.z].sort();
    assert.deepEqual(z, [0, 1], 'the 2 m edge is reported as its visible 1 m');
  });

  it('handles the local-frame origin of a georeferenced mesh', () => {
    const origin: [number, number, number] = [1000, 2000, 300];
    const ray: Ray = { origin: { x: 1001, y: 2000.05, z: 350 }, direction: { x: 0, y: 0, z: -1 } };
    const { snapTarget } = pick(new SnapDetector(), box(7, origin), ray, section(301));
    assert.equal(snapTarget?.type, SnapType.EDGE);
    assert.ok(Math.abs(snapTarget!.position.z - 301) < 1e-6);
    assert.ok(Math.abs(snapTarget!.position.y - 2000) < 1e-6);
  });

  it('an entity exempt from the section keeps its whole geometry', () => {
    const clip = { ...section(1), sectionExcludedIds: new Set([7]) };
    const ray = down(1, 0.05);
    const surface = new Raycaster().raycast(ray, [box()]);
    assert.ok(surface);
    const { snapTarget } = new SnapDetector().detectMagneticSnap(ray, [box()], surface, CAMERA, 800, NO_LOCK, OPTIONS, clip);
    assert.equal(snapTarget?.position.z, 2);
  });

  it('a crop box trims edges and yields a reachable contour', () => {
    const clip: PickClipState = { clipBox: { enabled: true, min: [-1, -1, -1], max: [3, 3, 1] } };
    const side: Ray = { origin: { x: 1, y: -50, z: 0.98 }, direction: { x: 0, y: 1, z: 0 } };
    const front = new Raycaster().raycast(side, [box()]);
    assert.ok(front);
    const { snapTarget } = new SnapDetector().detectMagneticSnap(side, [box()], front, { position: side.origin, fov: Math.PI / 4 }, 800, NO_LOCK, OPTIONS, clip);
    assert.ok(Math.abs(snapTarget!.position.z - 1) < 1e-6);
  });

  it('releases a held lock when the section changes, then acquires from the new geometry', () => {
    const detector = new SnapDetector();
    const mesh = box();
    const held = pick(detector, mesh, down(1, 0.05), section(1)).edgeLock;
    const lock = { edge: held.edge, meshExpressId: held.meshExpressId, lockStrength: 1 };
    const sameCut = pick(detector, mesh, down(1.2, 0.05), section(1), lock);
    assert.equal(sameCut.snapTarget?.position.z, 1, 'still sliding under an unchanged cut');
    const moved = pick(detector, mesh, down(1.2, 0.05), section(0.5), lock);
    assert.ok(Math.abs(moved.snapTarget!.position.z - 0.5) < 1e-6, 'the stale contour is gone');
  });

  it('an open shell has no section interior: parity between its walls must not attract the rim', () => {
    // Floor plus the two walls at y=0 and y=2, so the section is two open lines.
    const shell = box();
    shell.indices = new Uint32Array([0, 1, 2, 0, 2, 3, 0, 5, 1, 0, 4, 5, 3, 2, 6, 3, 6, 7]);
    const { snapTarget } = pick(new SnapDetector(), shell, down(1, 1), section(1));
    assert.equal(snapTarget?.position.z, 0, 'the visible floor, not a wall top over a metre away');
  });

  it('a ring section has a hole: a ray down through it is not inside the solid', () => {
    // A [0,3]^2 tube with a [1,2]^2 hole, on a floor, so the section is two nested loops.
    const v = [[0, 0], [3, 0], [3, 3], [0, 3], [1, 1], [2, 1], [2, 2], [1, 2]];
    const positions = new Float32Array([...v.flatMap(([x, y]) => [x, y, 0]), ...v.flatMap(([x, y]) => [x, y, 2])]);
    const quad = (a: number, b: number, c: number, d: number) => [a, b, c, a, c, d];
    const ring = (o: number) => [...quad(o, o + 1, o + 5, o + 4), ...quad(o + 1, o + 2, o + 6, o + 5), ...quad(o + 2, o + 3, o + 7, o + 6), ...quad(o + 3, o, o + 4, o + 7)];
    const floor = [8, 9, 10, 8, 10, 11].map((i) => i - 8);
    const tube: MeshData = {
      expressId: 9, positions, normals: new Float32Array(positions.length), color: [0.5, 0.5, 0.5, 1],
      indices: new Uint32Array([...floor, ...ring(0).map((i) => (i < 4 ? i : i + 4)), ...ring(4).map((i) => (i < 8 ? i : i + 4)),
        ...ring(0).map((i) => (i < 4 ? i + 8 : i + 8))]),
    };
    const camera = { position: { x: 1.5, y: 1.5, z: 50 }, fov: Math.PI / 4 };
    const ray = down(1.5, 1.5);
    const hit = new Raycaster().raycast(ray, [tube], (h) => h.point.z <= 1);
    assert.ok(hit);
    const { snapTarget } = new SnapDetector().detectMagneticSnap(ray, [tube], hit, camera, 800, NO_LOCK, OPTIONS, section(1));
    assert.equal(snapTarget?.position.z, 0, 'through the hole the floor shows; treated as inside, the rim 0.5 m away would win');
  });

  it('an inner-edge lock under a cut stays where the hit is, not where the entry point projects', () => {
    // A 10 m box cut at z=8; the ray enters at (5,5,8) and hits the inner face at
    // (10,9.8,3), next to the vertical edge at (10,10) and far from any contour.
    const big = box(11);
    big.positions = big.positions.map((v) => v * 5);
    const dir = { x: 5, y: 4.8, z: -5 };
    const len = Math.hypot(dir.x, dir.y, dir.z);
    const direction = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
    const origin = { x: 5 - direction.x * 20, y: 5 - direction.y * 20, z: 8 - direction.z * 20 };
    const ray: Ray = { origin, direction };
    const hit = new Raycaster().raycast(ray, [big], (h) => h.point.z <= 8);
    assert.ok(hit);
    const camera = { position: origin, fov: Math.PI / 4 };
    const options = { ...OPTIONS, screenSnapRadius: 79 };
    const detector = new SnapDetector();
    const first = detector.detectMagneticSnap(ray, [big], hit, camera, 800, NO_LOCK, options, section(8));
    assert.ok(Math.abs(first.snapTarget!.position.z - hit.point.z) < 1e-3, 'acquired beside the hit');
    const lock = { edge: first.edgeLock.edge, meshExpressId: 11, lockStrength: 1.5 };
    const held = detector.detectMagneticSnap(ray, [big], hit, camera, 800, lock, options, section(8));
    assert.equal(held.edgeLock.shouldRelease, false);
    assert.ok(Math.abs(held.snapTarget!.position.z - hit.point.z) < 1e-3, 'the same ray must not move the snap');
  });

  it('with edges off, a face centre on the removed side is not offered', () => {
    const ray: Ray = { origin: { x: 0.2, y: -50, z: 0.6 }, direction: { x: 0, y: 1, z: 0 } };
    const camera = { position: ray.origin, fov: Math.PI / 4 };
    const options = { snapToVertices: false, snapToEdges: false, snapToFaces: true, screenSnapRadius: 20 };
    const hit = new Raycaster().raycast(ray, [box()]);
    assert.ok(hit);
    const whole = new SnapDetector().detectMagneticSnap(ray, [box()], hit, camera, 800, NO_LOCK, options);
    assert.equal(whole.snapTarget?.type, SnapType.FACE_CENTER, 'its triangle reaches z=2, so the centre sits above the cut');
    assert.ok(whole.snapTarget!.position.z > 1);
    const cut = new SnapDetector().detectMagneticSnap(ray, [box()], hit, camera, 800, NO_LOCK, options, section(1));
    assert.equal(cut.snapTarget?.type, SnapType.FACE);
  });

  it('without a clip the geometry is the unclipped cache', () => {
    const { snapTarget } = pick(new SnapDetector(), box(), down(1, 0.05));
    assert.equal(snapTarget?.position.z, 2);
  });
});

