/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8769 on touch: a finger has no hover to prime the depth probe, so a
 * one-finger orbit on a large model starts on the fallback pivot and adopts
 * the probed surface a frame later, if the finger has not moved the camera.
 * Real hook, real `Camera`, a ground plane z = 0.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { Camera, type Renderer } from '@ifc-lite/renderer';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useTouchControls, type UseTouchControlsParams } from './useTouchControls.js';
import { PIVOT_RAYCAST_MAX_INDICES } from './orbitPivotCensus.js';

type Vec3 = { x: number; y: number; z: number };
const W = 800, H = 600;
const ref = <T,>(current: T) => ({ current });
const frame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function rig() {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: W, height: H });
  document.body.appendChild(canvas);
  const camera = new Camera();
  camera.setAspect(W / H);
  camera.setPosition(0, -1600, 1200);
  camera.setTarget(0, 0, 0);
  const pivots: (Vec3 | null)[] = [];
  const surfaces: (Vec3 | undefined)[] = [];
  const zoom = camera.zoom.bind(camera);
  camera.zoom = (...args: Parameters<Camera['zoom']>) => { surfaces.push(args[7] ? { ...args[7] } : undefined); zoom(...args); };
  const setOrbitCenter = camera.setOrbitCenter.bind(camera);
  camera.setOrbitCenter = (c) => { pivots.push(c ? { ...c } : null); setOrbitCenter(c); };
  const ground = (x: number, y: number): Vec3 | null => {
    const ray = camera.unprojectToRay(x, y, W, H);
    if (!(ray.direction.z < 0)) return null;
    const t = -ray.origin.z / ray.direction.z;
    return { x: ray.origin.x + ray.direction.x * t, y: ray.origin.y + ray.direction.y * t, z: 0 };
  };
  const raycasts: number[] = [];
  const heavy = { expressIds: [1, 2, 3], indexCount: PIVOT_RAYCAST_MAX_INDICES + 1 };
  const renderer = {
    getCamera: () => camera, getCanvas: () => canvas, requestRender() {},
    getScene: () => ({ getMeshes: () => [], getBatchedMeshes: () => [heavy], getInstancedEntityCount: () => 0 }),
    raycastScene: () => { raycasts.push(1); return null; },
    probeSurface: async (x: number, y: number) => ground(x, y),
  } as unknown as Renderer;
  const state = useViewerStore.getState();
  const params: UseTouchControlsParams = {
    canvasRef: ref(canvas), rendererRef: ref(renderer), isInitialized: true, activeToolRef: ref('select'),
    hiddenEntitiesRef: ref(new Set<number>()), isolatedEntitiesRef: ref(null), selectedEntityIdRef: ref(null),
    selectedModelIndexRef: ref(undefined), clearColorRef: ref([0, 0, 0, 1]), sectionPlaneRef: ref(state.sectionPlane),
    sectionRangeRef: ref(null), geometryRef: ref(null), isInteractingRef: ref(false), handlePickForSelection() {},
    openContextMenu() {},
    getPickOptions: () => ({ isStreaming: false, hiddenIds: new Set<number>(), isolatedIds: null }),
    touchStateRef: ref({ touches: [], lastDistance: 0, lastCenter: { x: 0, y: 0 }, tapStartTime: 0,
      tapStartPos: { x: 0, y: 0 }, didMove: false, multiTouch: false, twoFingerGesture: 'none' as const,
      gestureDistanceAccum: 0, gesturePanAccum: 0 }),
  };
  function Probe() { useTouchControls(params); return null; }
  render(<Probe />);
  return { canvas, camera, pivots, raycasts, ground, surfaces };
}

function finger(canvas: HTMLCanvasElement, x: number, y: number): Touch {
  return { identifier: 1, target: canvas, clientX: x, clientY: y } as unknown as Touch;
}
function touchEvent(kind: string, touches: Touch[]): Event {
  const event = new window.Event(kind, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: touches });
  return event;
}
const near = (a: Vec3 | null | undefined, b: Vec3 | null) =>
  !!a && !!b && Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-3;

describe('touch orbit pivot from the depth under the finger (#8769)', () => {
  const realRaf = globalThis.requestAnimationFrame;
  beforeEach(() => { globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame; });
  afterEach(() => {
    globalThis.requestAnimationFrame = realRaf;
    cleanup();
    for (const canvas of document.querySelectorAll('canvas')) canvas.remove();
  });

  it('adopts the probed surface a frame after the touch, before the finger moves', async () => {
    const r = rig();
    const under = r.ground(250, 420);
    act(() => { r.canvas.dispatchEvent(touchEvent('touchstart', [finger(r.canvas, 250, 420)])); });
    assert.ok(!near(r.pivots.at(-1), under), 'no probe yet: the fallback pivot');
    await frame();
    await frame();
    assert.ok(near(r.pivots.at(-1), under), `pivot ${JSON.stringify(r.pivots.at(-1))} is the ground under the finger`);
    assert.equal(r.raycasts.length, 0, 'the CPU raycast stays gated off');
    act(() => { r.canvas.dispatchEvent(touchEvent('touchend', [])); });
  });

  it('adopts it for the rest of the gesture even once the finger is orbiting (no drag threshold on touch)', async () => {
    const r = rig();
    const under = r.ground(250, 420);
    act(() => {
      r.canvas.dispatchEvent(touchEvent('touchstart', [finger(r.canvas, 250, 420)]));
      r.canvas.dispatchEvent(touchEvent('touchmove', [finger(r.canvas, 320, 400)]));
    });
    await frame();
    await frame();
    assert.ok(near(r.pivots.at(-1), under), `pivot ${JSON.stringify(r.pivots.at(-1))} is the ground first touched`);
    act(() => { r.canvas.dispatchEvent(touchEvent('touchend', [])); });
  });

  it('never applies a probe that lands after the finger lifted', async () => {
    const r = rig();
    act(() => {
      r.canvas.dispatchEvent(touchEvent('touchstart', [finger(r.canvas, 250, 420)]));
      r.canvas.dispatchEvent(touchEvent('touchend', []));
    });
    const count = r.pivots.length;
    await frame();
    await frame();
    assert.equal(r.pivots.length, count);
  });

  it('pinch zoom-in approaches the probed surface under the pinch, not a plain dolly', async () => {
    const r = rig();
    const two = (s: number) => [
      { identifier: 1, target: r.canvas, clientX: 400 - s, clientY: 420 } as unknown as Touch,
      { identifier: 2, target: r.canvas, clientX: 400 + s, clientY: 420 } as unknown as Touch,
    ];
    act(() => { r.canvas.dispatchEvent(touchEvent('touchstart', two(100))); });
    for (let s = 104; s < 200; s += 4) {
      act(() => { r.canvas.dispatchEvent(touchEvent('touchmove', two(s))); });
      await frame();
    }
    act(() => { r.canvas.dispatchEvent(touchEvent('touchend', [])); });
    const used = r.surfaces.filter((p): p is Vec3 => p !== undefined);
    assert.ok(used.length > 0, `no pinch step zoomed toward a surface (${r.surfaces.length} steps)`);
    assert.ok(used.every((p) => Math.abs(p.z) < 1e-6), 'every surface used is the ground');
    assert.ok(r.camera.getPosition().z > 0);
    assert.equal(r.raycasts.length, 0);
  });
});
