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
const section = (distance: number, capped = true): PickClipState => ({
  sectionPlane: { normal: [0, 0, 1], distance, flipped: false }, capsVisible: capped,
});

/** The magnetic pick the engine runs: clipped ray, then cap resolution, then snap. */
function pick(detector: SnapDetector, mesh: MeshData, ray: Ray, clip?: PickClipState | null, lock = NO_LOCK) {
  const surface = new Raycaster().raycast(ray, [mesh], (hit) => {
    if (!clip?.sectionPlane) return true;
    return hit.point.z <= clip.sectionPlane.distance;
  });
  assert.ok(surface, 'the ray hits the box');
  const intersection = detector.resolveCutCap(ray, mesh, surface, clip) ?? surface;
  return { intersection, ...detector.detectMagneticSnap(ray, [mesh], intersection, CAMERA, 800, lock, OPTIONS, clip) };
}

describe('magnetic snap under a section (#8659)', () => {
  it('a ray over the cap stops on the cut face, not the hidden inside of the solid', () => {
    const { intersection } = pick(new SnapDetector(), box(), down(1, 1), section(1));
    assert.equal(intersection.point.z, 1);
    assert.equal(intersection.distance, 49);
    assert.deepEqual(intersection.normal, { x: 0, y: 0, z: 1 });
    assert.equal(intersection.cutCap, true);
  });

  it('a hidden cap leaves the ray on the inside surface the user actually sees', () => {
    const { intersection } = pick(new SnapDetector(), box(), down(1, 1), section(1, false));
    assert.equal(intersection.point.z, 0);
    assert.equal(intersection.cutCap, undefined);
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
    const detector = new SnapDetector();
    assert.equal(detector.resolveCutCap(ray, box(), surface, clip), null);
    const { snapTarget } = detector.detectMagneticSnap(ray, [box()], surface, CAMERA, 800, NO_LOCK, OPTIONS, clip);
    assert.equal(snapTarget?.position.z, 2);
  });

  it('a crop box trims edges and yields a contour but draws no cap', () => {
    const clip: PickClipState = { clipBox: { enabled: true, min: [-1, -1, -1], max: [3, 3, 1] } };
    const detector = new SnapDetector();
    const ray = down(1, 1);
    const surface = new Raycaster().raycast(ray, [box()], (hit) => hit.point.z <= 1);
    assert.ok(surface);
    assert.equal(detector.resolveCutCap(ray, box(), surface, clip), null);
    const side: Ray = { origin: { x: 1, y: -50, z: 0.98 }, direction: { x: 0, y: 1, z: 0 } };
    const front = new Raycaster().raycast(side, [box()]);
    assert.ok(front);
    const { snapTarget } = detector.detectMagneticSnap(side, [box()], front, { position: side.origin, fov: Math.PI / 4 }, 800, NO_LOCK, OPTIONS, clip);
    assert.ok(Math.abs(snapTarget!.position.z - 1) < 1e-6, 'the contour on the visible wall is reachable');
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

  it('an open shell has no cap: even parity between its walls must not invent one', () => {
    // Floor plus the two walls at y=0 and y=2, so the section is two open lines.
    const shell = box();
    shell.indices = new Uint32Array([0, 1, 2, 0, 2, 3, 0, 5, 1, 0, 4, 5, 3, 2, 6, 3, 6, 7]);
    const { intersection } = pick(new SnapDetector(), shell, down(1, 1), section(1));
    assert.equal(intersection.point.z, 0, 'the visible floor, not a point in the air');
    assert.equal(intersection.cutCap, undefined);
  });

  it('without a clip the geometry is the unclipped cache', () => {
    const { snapTarget } = pick(new SnapDetector(), box(), down(1, 0.05));
    assert.equal(snapTarget?.position.z, 2);
  });
});

