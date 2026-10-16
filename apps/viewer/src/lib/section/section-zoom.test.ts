/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Exact zoom (#7545): the framing multiple for a margin, and what the frame ends up
 * showing, judged on the real camera's own view-projection rather than on a constant.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@ifc-lite/renderer';
import { zoomPadding } from './section-zoom-spec.js';

const box = (dx: number, dy: number, dz: number) => ({ min: { x: 0, y: 0, z: 0 }, max: { x: dx, y: dy, z: dz } });

describe('zoomPadding', () => {
  it('a fraction is room on each side of the largest extent', () => {
    assert.ok(Math.abs(zoomPadding(box(10, 4, 2), { kind: 'fraction', value: 0.1 }) - 1.2) < 1e-12);
    assert.equal(zoomPadding(box(10, 4, 2), { kind: 'fraction', value: 0 }), 1);
  });

  it('a length is that many metres on each side, whatever the extent', () => {
    // 10 m extent, 2 m each side: the frame holds 14 m.
    assert.ok(Math.abs(zoomPadding(box(10, 4, 2), { kind: 'metres', value: 2 }) - 1.4) < 1e-12);
    assert.ok(Math.abs(zoomPadding(box(100, 4, 2), { kind: 'metres', value: 2 }) - 1.04) < 1e-12);
  });

  it('never goes inside the target, ignores a garbage margin, and frames a single point edge to edge', () => {
    assert.equal(zoomPadding(box(10, 4, 2), { kind: 'fraction', value: -1 }), 1);
    assert.equal(zoomPadding(box(10, 4, 2), { kind: 'metres', value: Number.NaN }), 1);
    assert.equal(zoomPadding(box(0, 0, 0), { kind: 'fraction', value: 0.1 }), 1);
  });

  it('caps an absurd fraction', () => {
    assert.equal(zoomPadding(box(10, 4, 2), { kind: 'fraction', value: 1e9 }), 1 + 2 * 5);
  });
});

/** Where `Camera` puts a world point: the fraction of the half-frame it spans (1 = at the edge). */
function frameFill(camera: Camera, bounds: ReturnType<typeof box>): number {
  const m = camera.getViewProjMatrix().m;
  let worst = 0;
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    const nx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w;
    const ny = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w;
    worst = Math.max(worst, Math.abs(nx), Math.abs(ny));
  }
  return worst;
}

describe('the frame a margin produces (on the renderer\'s own camera)', () => {
  const target = box(10, 6, 4);

  // Both projections are exact: perspective solves the standoff on the projected corners (#7617).
  for (const [mode, tolerance] of [['orthographic', 0.005], ['perspective', 0.005]] as const) {
    it(`${mode}: the target fills 1 / (1 + 2 * margin) of the limiting dimension, and is always inside`, async () => {
      const camera = new Camera();
      camera.setAspect(1);
      if (mode === 'orthographic') camera.setProjectionMode('orthographic');
      camera.setPosition(5, 3, 40);
      camera.setTarget(5, 3, 2);
      // Edge to edge first, then with a 10 % margin: a 10 % margin must leave exactly 1/1.2 of the frame in use.
      await camera.frameBounds(target.min, target.max, 0, zoomPadding(target, { kind: 'fraction', value: 0 }));
      const tight = frameFill(camera, target);
      await camera.frameBounds(target.min, target.max, 0, zoomPadding(target, { kind: 'fraction', value: 0.1 }));
      const loose = frameFill(camera, target);
      assert.ok(tight <= 1.0001, `${mode}: edge to edge still contains the target (${tight})`);
      assert.ok(Math.abs(loose / tight - 1 / 1.2) < tolerance, `${mode}: ratio ${loose / tight} vs ${1 / 1.2}`);
    });
  }
});

describe('the margin in perspective is the margin that was asked for (#7617)', () => {
  // Not cubes, not centred on the origin: the near corners of each project larger than its centre plane.
  const boxes = [
    { min: { x: 12, y: -4, z: 3 }, max: { x: 22, y: 2, z: 7 } },
    { min: { x: -30, y: 5, z: -8 }, max: { x: -2, y: 9, z: 14 } },
  ];
  const aspects = [1.6, 0.7];

  for (const fovDeg of [20, 45, 90]) {
    for (const margin of [0, 0.1, 0.25]) {
      it(`${fovDeg} degree field, ${margin * 100} % margin: the box fills 1 / (1 + 2 * margin) of the limiting axis`, async () => {
        for (const bounds of boxes) {
          for (const aspect of aspects) {
            const camera = new Camera();
            camera.setAspect(aspect);
            camera.setFOV((fovDeg * Math.PI) / 180);
            const cx = (bounds.min.x + bounds.max.x) / 2;
            const cy = (bounds.min.y + bounds.max.y) / 2;
            const cz = (bounds.min.z + bounds.max.z) / 2;
            // An oblique approach from a long way off, so no axis is aligned with the view.
            camera.setPosition(cx + 60, cy + 35, cz + 90);
            camera.setTarget(cx, cy, cz);
            await camera.frameBounds(bounds.min, bounds.max, 0, zoomPadding(bounds, { kind: 'fraction', value: margin }));
            const fill = frameFill(camera, bounds);
            const ideal = 1 / (1 + 2 * margin);
            assert.ok(Math.abs(fill - ideal) < 0.005 * ideal, `aspect ${aspect}: fills ${fill} of the half-frame, asked for ${ideal}`);
          }
        }
      });
    }
  }
});
