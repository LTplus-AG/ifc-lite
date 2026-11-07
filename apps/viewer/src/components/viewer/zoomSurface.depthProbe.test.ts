/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8769: on a large-extent model the CPU raycast is gated off (census,
 * robust anchor, streaming), so a wheel zoom was a plain dolly that flew
 * through the ground. The gated pick now answers from the last frame's depth
 * (`Renderer.probeSurface`, `surfaceProbe.ts`).
 *
 * The fixture is a site: a ground plane z = 0 a few km wide, under a camera
 * fitted to it, carried by a few heavy triangulated meshes that trip the
 * census. The renderer stub's `probeSurface` intersects the ground along the
 * cursor ray of the camera it was asked from, as the depth texture would.
 */

import '../../test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@ifc-lite/renderer';
import { applyWheelZoom, type WheelZoomEvent } from './wheelZoom.js';
import { createCentreSurfaceZoom, createZoomSurfacePicker, type SurfacePoint } from './zoomSurface.js';
import { PIVOT_RAYCAST_MAX_INDICES } from './orbitPivotCensus.js';

const W = 800, H = 600;
const CURSOR = { x: 560, y: 380 }; // off-centre, over the ground

interface SiteOptions { probe?: boolean; small?: boolean; anchor?: boolean; streaming?: boolean }

function site(opts: SiteOptions = {}) {
  const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) as DOMRect } as HTMLCanvasElement;
  const camera = new Camera();
  camera.setAspect(W / H);
  // Fitted to a ~3 km site: about 2 km out, looking down at its centre.
  camera.setPosition(0, -1600, 1200);
  camera.setTarget(0, 0, 0);
  if (opts.anchor) camera.setOrbitAnchorBounds({ min: { x: -1500, y: -1500, z: -5 }, max: { x: 1500, y: 1500, z: 30 } });
  const raycasts: Array<[number, number]> = [];
  const probes: Array<[number, number]> = [];
  /** The ground under a canvas point, for the camera as it is now. */
  const ground = (x: number, y: number): SurfacePoint | null => {
    const ray = camera.unprojectToRay(x, y, W, H);
    if (!(ray.direction.z < 0)) return null;
    const t = -ray.origin.z / ray.direction.z;
    return { x: ray.origin.x + ray.direction.x * t, y: ray.origin.y + ray.direction.y * t, z: 0 };
  };
  const heavy = { expressIds: [1, 2, 3], indexCount: PIVOT_RAYCAST_MAX_INDICES + 1 };
  const renderer = {
    getScene: () => ({ getMeshes: () => [], getBatchedMeshes: () => (opts.small ? [] : [heavy]), getInstancedEntityCount: () => 0 }),
    raycastScene: (x: number, y: number) => {
      raycasts.push([x, y]);
      const p = ground(x, y);
      return p ? { intersection: { point: p } } : null;
    },
    getCanvas: () => canvas,
    ...(opts.probe === false ? {} : {
      probeSurface: async (x: number, y: number) => { probes.push([x, y]); return ground(x, y); },
    }),
  };
  const visibility = { hiddenIds: new Set<number>(), isolatedIds: null as Set<number> | null };
  const getPickOptions = () => ({ isStreaming: opts.streaming ?? false, ...visibility });
  const pickSurface = createZoomSurfacePicker(renderer, camera, getPickOptions);
  return { canvas, camera, renderer, raycasts, probes, pickSurface, getPickOptions, visibility };
}

function wheel(x: number, y: number): WheelZoomEvent {
  return { deltaY: -120, ctrlKey: false, metaKey: false, clientX: x, clientY: y, preventDefault() {} };
}

/** Let the scheduled probe run and its readback land (a frame, here a macrotask). */
const frame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** `n` wheel-in notches at the cursor, a frame apart; the camera height after each. */
async function zoomIn(s: ReturnType<typeof site>, n: number): Promise<number[]> {
  const zs: number[] = [];
  for (let i = 0; i < n; i++) {
    applyWheelZoom(wheel(CURSOR.x, CURSOR.y), { camera: s.camera, canvas: s.canvas, fastZoom: false, fineModifierHeld: false, pickSurface: s.pickSurface });
    zs.push(s.camera.getPosition().z);
    await frame();
  }
  return zs;
}

describe('wheel zoom on a large-extent site stops at the ground (#8769)', () => {
  const realRaf = globalThis.requestAnimationFrame;
  beforeEach(() => { globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame; });
  afterEach(() => { globalThis.requestAnimationFrame = realRaf; });

  it('without a depth probe the gated zoom is a plain dolly that flies through the ground (the defect)', async () => {
    const zs = await zoomIn(site({ probe: false }), 80);
    assert.ok(Math.min(...zs) < 0, `plain zoom never passed the ground: min z ${Math.min(...zs)}`);
  });

  it('with the hover priming the probe, every notch stays above the ground and closes in on it', async () => {
    const s = site();
    s.pickSurface.prime?.(CURSOR.x, CURSOR.y);
    await frame();
    const zs = await zoomIn(s, 80);
    zs.forEach((z, i) => assert.ok(z > 0, `notch ${i}: camera at z ${z} is at or below the ground`));
    assert.ok(zs[zs.length - 1] < 5, `80 notches got close to the ground: z ${zs[zs.length - 1]}`);
    assert.equal(s.raycasts.length, 0, 'the CPU raycast stays gated off on the large model');
  });

  it('without priming, the gesture adopts the probe once it lands and still never passes the ground', async () => {
    const s = site();
    const zs = await zoomIn(s, 80);
    zs.forEach((z, i) => assert.ok(z > 0, `notch ${i}: camera at z ${z} is at or below the ground`));
    assert.ok(s.probes.length > 1, 're-probes as it goes, so the point sharpens as the camera nears');
  });

  it('answers from the probe for a robust-anchor model and while streaming, too', async () => {
    for (const opts of [{ small: true, anchor: true }, { small: true, streaming: true }] satisfies SiteOptions[]) {
      const s = site(opts);
      s.pickSurface.prime?.(CURSOR.x, CURSOR.y);
      await frame();
      const zs = await zoomIn(s, 80);
      assert.ok(Math.min(...zs) > 0, `${JSON.stringify(opts)}: min z ${Math.min(...zs)}`);
      assert.equal(s.raycasts.length, 0, `${JSON.stringify(opts)}: no CPU raycast`);
    }
  });

  it('keeps the CPU raycast, picked once per gesture, on a small model (#5393), and never probes', async () => {
    const s = site({ small: true });
    s.pickSurface.prime?.(CURSOR.x, CURSOR.y);
    const zs = await zoomIn(s, 30);
    assert.ok(Math.min(...zs) > 0);
    assert.equal(s.raycasts.length, 1, `raycasts: ${JSON.stringify(s.raycasts)}`);
    assert.equal(s.probes.length, 0, 'the small model does no depth reads at all');
    assert.equal(s.pickSurface.live?.() ?? false, false);
  });

  it('switches a running gesture to the probe when the raycast becomes gated mid-gesture', async () => {
    const opts: SiteOptions = { small: true };
    const s = site(opts);
    await zoomIn(s, 2);
    assert.equal(s.raycasts.length, 1, 'the gesture began on the CPU raycast');
    opts.streaming = true; // a load starts streaming while the wheel keeps turning
    await zoomIn(s, 5);
    assert.equal(s.raycasts.length, 1, 'no more CPU raycasts once gated');
    assert.ok(s.probes.length > 0, 'later notches re-pick from the depth probe');
  });

  it('ignores a probed point that no longer projects under the cursor', async () => {
    const s = site();
    s.pickSurface.prime?.(CURSOR.x, CURSOR.y);
    await frame();
    assert.ok(s.pickSurface(CURSOR.x, CURSOR.y), 'the primed point is under the cursor');
    assert.equal(s.pickSurface(CURSOR.x + 40, CURSOR.y), null, 'a point 40 px away is not the surface under it');
    s.camera.setPosition(300, -1600, 1200); // panned: the old point left the cursor
    s.camera.setTarget(300, 0, 0);
    assert.equal(s.pickSurface(CURSOR.x, CURSOR.y), null);
  });

  it('drops a probed point once the hidden or isolated set changed (it may sit on a hidden element)', async () => {
    const s = site();
    s.pickSurface.prime?.(CURSOR.x, CURSOR.y);
    await frame();
    assert.ok(s.pickSurface(CURSOR.x, CURSOR.y));
    await frame();
    s.visibility.hiddenIds.add(7); // an in-place mutation: the size guard catches it
    assert.equal(s.pickSurface(CURSOR.x, CURSOR.y), null, 'the probe from before the hide is not reused');
    await frame();
    assert.ok(s.pickSurface(CURSOR.x, CURSOR.y), 'the next probe, under the new visibility, is');
    s.visibility.isolatedIds = new Set([1]);
    assert.equal(s.pickSurface(CURSOR.x, CURSOR.y), null, 'isolation is a new visibility too');
  });

  it('a same-sized but different hidden set is a new visibility (the store copies on write)', async () => {
    const s = site();
    s.visibility.hiddenIds = new Set([1]); // hide A
    s.pickSurface.prime?.(CURSOR.x, CURSOR.y);
    await frame();
    assert.ok(s.pickSurface(CURSOR.x, CURSOR.y), 'probed with A hidden');
    await frame();
    s.visibility.hiddenIds = new Set([1, 2]); // hide B
    s.visibility.hiddenIds = new Set([2]); // show A: size 1 again, different members
    assert.equal(s.pickSurface(CURSOR.x, CURSOR.y), null, 'the point probed with A hidden is not reused');
  });

  it('coalesces probes to one readback in flight, answering the newest position', async () => {
    const s = site();
    for (let i = 0; i < 20; i++) s.pickSurface.prime?.(100 + i, 200);
    await frame();
    await frame();
    assert.deepEqual(s.probes, [[119, 200]]);
  });

  it('the cursorless zoom (toolbar, SpaceMouse) stops at the ground too', async () => {
    const s = site();
    const zoom = createCentreSurfaceZoom(s.renderer, s.camera, s.canvas, s.getPickOptions);
    const zs: number[] = [];
    for (let i = 0; i < 80; i++) {
      zoom(-50);
      zs.push(s.camera.getPosition().z);
      await frame();
    }
    zs.forEach((z, i) => assert.ok(z > 0, `step ${i}: camera at z ${z} is at or below the ground`));
  });
});
