/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The adaptive fit (load, Home, clash framing) frames the model in
 * orthographic projection too (#8802 R6 review). It used to change only the
 * distance, which sets no scale in orthographic projection, so the zoom
 * stayed wherever it was: at 390x800 with `orthoSize = 5`, a 20 x 10 x 20 box
 * landed at x = -936..1326 on a 390 px screen.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from './camera.js';

const BOUNDS = { min: { x: -10, y: -5, z: -10 }, max: { x: 10, y: 5, z: 10 } };

/** The eight corners on screen, in CSS px. */
function cornersOnScreen(camera: Camera, width: number, height: number): { xs: number[]; ys: number[] } {
  const xs: number[] = []; const ys: number[] = [];
  for (const x of [BOUNDS.min.x, BOUNDS.max.x]) for (const y of [BOUNDS.min.y, BOUNDS.max.y]) for (const z of [BOUNDS.min.z, BOUNDS.max.z]) {
    const p = camera.projectToScreen({ x, y, z }, width, height);
    assert.ok(p, 'every corner projects');
    xs.push(p.x); ys.push(p.y);
  }
  return { xs, ys };
}

function orthoCamera(width: number, height: number): Camera {
  const camera = new Camera();
  camera.setAspect(width / height);
  camera.setProjectionMode('orthographic');
  camera.setOrthoSize(5);
  return camera;
}

/** Largest distance of a corner from the screen centre, as a share of the half-frame, over both axes. */
function widestShare(xs: number[], ys: number[], width: number, height: number): number {
  return Math.max(...xs.map((x) => Math.abs(x - width / 2) / (width / 2)), ...ys.map((y) => Math.abs(y - height / 2) / (height / 2)));
}

describe('orthographic adaptive fit (#8802 R6)', () => {
  for (const [label, fit] of [
    ['snapped (load-time fit)', (c: Camera) => c.fitBoundsAdaptive(BOUNDS)],
    ['animated (Home, clash framing)', (c: Camera) => c.fitBoundsAdaptive(BOUNDS, { animate: true, duration: 0 })],
  ] as const) {
    it(`frames the whole box on a 390x800 phone, ${label}`, () => {
      const camera = orthoCamera(390, 800);
      fit(camera);
      const { xs, ys } = cornersOnScreen(camera, 390, 800);
      assert.ok(Math.min(...xs) >= 0 && Math.max(...xs) <= 390, `x ${Math.min(...xs).toFixed(0)}..${Math.max(...xs).toFixed(0)} must lie on the 390 px screen`);
      assert.ok(Math.min(...ys) >= 0 && Math.max(...ys) <= 800, `y ${Math.min(...ys).toFixed(0)}..${Math.max(...ys).toFixed(0)} must lie on the 800 px screen`);
      // The same 1.15 margin the perspective fit keeps: the binding axis is filled to 1 / 1.15.
      assert.ok(Math.abs(widestShare(xs, ys, 390, 800) - 1 / 1.15) < 1e-6, `widest corner at ${widestShare(xs, ys, 390, 800)}`);
    });
  }

  it('frames both axes on a landscape viewport too', () => {
    const camera = orthoCamera(1600, 900);
    camera.fitBoundsAdaptive(BOUNDS);
    const { xs, ys } = cornersOnScreen(camera, 1600, 900);
    assert.ok(Math.abs(widestShare(xs, ys, 1600, 900) - 1 / 1.15) < 1e-6);
  });

  it('leaves the perspective zoom state alone', () => {
    const camera = new Camera();
    camera.setAspect(390 / 800);
    camera.setOrthoSize(5);
    camera.fitBoundsAdaptive(BOUNDS);
    assert.equal(camera.getOrthoSize(), 5, 'orthoSize is not in play in perspective');
  });
});
