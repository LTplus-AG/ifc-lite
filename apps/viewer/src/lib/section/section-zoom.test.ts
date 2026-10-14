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

  // Orthographic is exact. Perspective is exact for the target's centre plane; its nearer corners
  // project a little larger, so the margin of the 3-D box as a whole reads within a few percent.
  for (const [mode, tolerance] of [['orthographic', 0.01], ['perspective', 0.035]] as const) {
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
