/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5924 - the toolbar zoom-in (`cameraCallbacks.zoomIn`, `centreZoom(-50)` in
 * Viewport.tsx) stops short of the surface at the viewport centre, the
 * cursorless sibling of the wheel's #5393 and the pinch's #5547.
 *
 * A real `Camera` behind the shared, gated `createZoomSurfacePicker`; the
 * renderer stub's `raycastScene` is a thin wall under the viewport centre.
 * The SpaceMouse dolly rides the same helper and has its own mounted-hook
 * test (`useSpaceMouseControls.surfaceZoom.test.tsx`).
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@ifc-lite/renderer';
import { createCentreSurfaceZoom, SURFACE_PICK_IDLE_MS } from './zoomSurface.js';

const WALL_Z = 2;
/** The toolbar zoom-in's step. */
const TOOLBAR_ZOOM_IN = -50;

interface RigOptions { hit?: boolean; isStreaming?: boolean; entities?: number; width?: number }

function rig(opts: RigOptions = {}) {
  const camera = new Camera();
  camera.setAspect(800 / 600);
  camera.setPosition(0, 0, 10);
  camera.setTarget(0, 0, 0);
  const raycasts: Array<[number, number]> = [];
  const renderer = {
    getScene: () => ({ getMeshes: () => [], getBatchedMeshes: () => [], getInstancedEntityCount: () => opts.entities ?? 10 }),
    raycastScene: (x: number, y: number) => {
      raycasts.push([x, y]);
      return opts.hit === false ? null : { intersection: { point: { x: 0, y: 0, z: WALL_Z } } };
    },
  };
  const canvas = { getBoundingClientRect: () => ({ width: opts.width ?? 800, height: 600 }) as DOMRect };
  const zoom = createCentreSurfaceZoom(renderer, camera, canvas,
    () => ({ isStreaming: opts.isStreaming ?? false, hiddenIds: new Set<number>(), isolatedIds: null }));
  const clicks = (n: number, delta = TOOLBAR_ZOOM_IN) => Array.from({ length: n }, () => {
    zoom(delta);
    return camera.getPosition().z;
  });
  return { camera, raycasts, zoom, clicks };
}

describe('toolbar zoom-in stops short of the surface at the viewport centre (#5924)', () => {
  const realNow = Date.now;
  let clock = 1_000_000;
  beforeEach(() => { clock = 1_000_000; Date.now = () => clock; });
  afterEach(() => { Date.now = realNow; });

  it('without a surface hit, repeated zoom-in clicks pass through the wall (the defect)', () => {
    const zs = rig({ hit: false }).clicks(60);
    assert.ok(zs[0] < 10, 'a zoom-in click must zoom in');
    assert.ok(Math.min(...zs) < WALL_Z, `plain zoom never passed the wall: min z ${Math.min(...zs)}`);
  });

  it('with a surface hit, repeated zoom-in clicks approach the wall and never pass it', () => {
    const zs = rig().clicks(120);
    zs.forEach((z, i) => assert.ok(z > WALL_Z, `click ${i}: camera at z ${z} is at or behind the wall`));
    for (let i = 1; i < zs.length; i++) assert.ok(zs[i] <= zs[i - 1], `click ${i} moved away from the wall`);
    assert.ok(zs[zs.length - 1] - WALL_Z < 0.1, `${zs.length} clicks got close to the wall: z ${zs[zs.length - 1]}`);
  });

  it('raycasts at the viewport centre in CSS px, once per run of clicks', () => {
    const r = rig();
    r.clicks(5);
    assert.deepEqual(r.raycasts, [[400, 300]]);
  });

  it('re-picks after a pause, since the scene may change under a still camera', () => {
    const r = rig();
    r.clicks(1);
    clock += SURFACE_PICK_IDLE_MS;
    r.clicks(1);
    assert.equal(r.raycasts.length, 2);
  });

  it('re-picks by age since the pick during a continuous run, not only after a pause', () => {
    const r = rig();
    for (let i = 0; i < 20; i++) { r.clicks(1); clock += 50; } // 1 s of steps 50 ms apart
    assert.equal(r.raycasts.length, Math.ceil((20 * 50) / SURFACE_PICK_IDLE_MS));
  });

  it('a run that began while streaming picks the surface once streaming ends', () => {
    const opts: RigOptions = { isStreaming: true };
    const r = rig(opts);
    r.clicks(1);
    opts.isStreaming = false;
    const zs: number[] = [];
    for (let i = 0; i < 150; i++) { clock += 50; zs.push(...r.clicks(1)); }
    assert.ok(r.raycasts.length > 0, 'never picked after streaming ended');
    zs.forEach((z, i) => assert.ok(z > WALL_Z, `step ${i}: camera at z ${z} is at or behind the wall`));
  });

  it('re-picks after another camera move took it off the picked ray', () => {
    const r = rig();
    r.clicks(1);
    r.camera.orbit(40, 0, false);
    r.clicks(1);
    assert.equal(r.raycasts.length, 2);
  });

  it('never raycasts for zoom-out, which cannot pass through anything', () => {
    const r = rig();
    r.clicks(3, 50);
    assert.ok(r.camera.getPosition().z > 10, 'zoom-out must zoom out');
    assert.equal(r.raycasts.length, 0);
  });

  it('skips the raycast while streaming, above the census limit, or on a zero-size viewport', () => {
    for (const [label, opts] of [
      ['streaming', { isStreaming: true }],
      ['large model', { entities: 1_000_000 }],
      ['zero-size viewport', { width: 0 }],
    ] as const) {
      const r = rig(opts);
      const zs = r.clicks(3);
      assert.equal(r.raycasts.length, 0, label);
      assert.ok(zs[zs.length - 1] < 10, `${label}: still zooms (plain)`);
    }
  });
});
