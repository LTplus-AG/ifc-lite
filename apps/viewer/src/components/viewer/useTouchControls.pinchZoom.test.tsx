/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5547 - touch pinch zooms toward the surface under the pinch, the sibling of
 * the wheel's #5393 (`wheelZoom.test.ts`, `useMouseControls.wheelZoom.test.tsx`).
 *
 * Mounts the real hook against a real `Camera` and dispatches touch events at
 * the canvas, so the whole path (gesture lock, midpoint, gate, pick cache,
 * `Camera.zoom(..., surfacePoint)`) is exercised. The renderer stub supplies
 * only what the hook reads; its `raycastScene` is the thin wall under the pinch.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { Camera, type Renderer } from '@ifc-lite/renderer';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useTouchControls, type UseTouchControlsParams } from './useTouchControls.js';

// A thin wall, the plane z = 2, under the canvas-centre pinch of a camera at
// z = 10 looking at the origin.
const WALL_Z = 2;
const CX = 400, CY = 300;
const ref = <T,>(current: T) => ({ current });

interface RigOptions { hit?: boolean; isStreaming?: boolean; entities?: number; robustAnchor?: boolean }

function rig(opts: RigOptions = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = 800; canvas.height = 600;
  canvas.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 600 });
  document.body.appendChild(canvas);
  const camera = new Camera();
  camera.setAspect(800 / 600);
  camera.setPosition(0, 0, 10);
  camera.setTarget(0, 0, 0);
  if (opts.robustAnchor) camera.setOrbitAnchorBounds({ min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } });
  const raycasts: Array<[number, number]> = [];
  const entities = opts.entities ?? 10;
  const renderer = {
    getCamera: () => camera, requestRender() {},
    getScene: () => ({ getMeshes: () => [], getBatchedMeshes: () => [], getInstancedEntityCount: () => entities }),
    raycastScene: (x: number, y: number) => {
      raycasts.push([x, y]);
      return opts.hit === false ? null : { intersection: { point: { x: 0, y: 0, z: WALL_Z } } };
    },
  } as unknown as Renderer;
  const state = useViewerStore.getState();
  const params: UseTouchControlsParams = {
    canvasRef: ref(canvas), rendererRef: ref(renderer), isInitialized: true, activeToolRef: ref('select'),
    hiddenEntitiesRef: ref(new Set<number>()), isolatedEntitiesRef: ref(null), selectedEntityIdRef: ref(null),
    selectedModelIndexRef: ref(undefined), clearColorRef: ref([0, 0, 0, 1]), sectionPlaneRef: ref(state.sectionPlane),
    sectionRangeRef: ref(null), geometryRef: ref(null), isInteractingRef: ref(false), handlePickForSelection() {},
    getPickOptions: () => ({ isStreaming: opts.isStreaming ?? false, hiddenIds: new Set<number>(), isolatedIds: null }),
    touchStateRef: ref({ touches: [], lastDistance: 0, lastCenter: { x: 0, y: 0 }, tapStartTime: 0,
      tapStartPos: { x: 0, y: 0 }, didMove: false, multiTouch: false, twoFingerGesture: 'none' as const,
      gestureDistanceAccum: 0, gesturePanAccum: 0 }),
  };
  function Probe() { useTouchControls(params); return null; }
  render(<Probe />);
  return { canvas, camera, raycasts };
}

/** Two fingers `2 * r` apart, centred on the canvas. */
function fingers(canvas: HTMLCanvasElement, r: number): Touch[] {
  return [
    { identifier: 1, target: canvas, clientX: CX - r, clientY: CY } as unknown as Touch,
    { identifier: 2, target: canvas, clientX: CX + r, clientY: CY } as unknown as Touch,
  ];
}

function touchEvent(kind: string, touches: Touch[]): Event {
  const event = new window.Event(kind, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: touches });
  return event;
}

/**
 * One two-finger gesture through the given finger half-spreads, then lift.
 * Returns the camera z after every move.
 */
function pinch(r: ReturnType<typeof rig>, spreads: number[]): number[] {
  const zs: number[] = [];
  act(() => {
    r.canvas.dispatchEvent(touchEvent('touchstart', fingers(r.canvas, spreads[0])));
    for (const s of spreads.slice(1)) {
      r.canvas.dispatchEvent(touchEvent('touchmove', fingers(r.canvas, s)));
      zs.push(r.camera.getPosition().z);
    }
    r.canvas.dispatchEvent(touchEvent('touchend', []));
  });
  return zs;
}

/**
 * Spreads 20, 40, ..., 400: 19 steps, each a full-size zoom notch. Spreading
 * the fingers zooms in and bringing them together zooms out, the mobile
 * convention (#5777; it was the reverse until then).
 */
const ZOOM_OUT = Array.from({ length: 20 }, (_, i) => 400 - 20 * i);
const ZOOM_IN = [...ZOOM_OUT].reverse();

describe('touch pinch zooms toward the surface under the pinch (#5547)', () => {
  afterEach(() => {
    cleanup();
    for (const canvas of document.querySelectorAll('canvas')) canvas.remove();
  });

  it('spreading the fingers zooms in and closing them zooms out, the mobile convention (#5777)', () => {
    const spread = pinch(rig({ hit: false }), [100, 140]);
    assert.ok(spread[0] < 10, `spreading moved the camera away: z ${spread[0]}`);
    cleanup();
    const close = pinch(rig({ hit: false }), [140, 100]);
    assert.ok(close[0] > 10, `closing moved the camera closer: z ${close[0]}`);
  });

  it('without a surface hit, repeated zoom-in pinches pass through the wall (the defect)', () => {
    const r = rig({ hit: false });
    const zs = [0, 1, 2].flatMap(() => pinch(r, ZOOM_IN));
    assert.ok(zs[0] < 10, 'the ZOOM_IN pinch must zoom in (#5777)');
    assert.ok(Math.min(...zs) < WALL_Z, `plain zoom never passed the wall: min z ${Math.min(...zs)}`);
  });

  it('with a surface hit, repeated zoom-in pinches approach the wall and never pass it', () => {
    const r = rig();
    const zs = [0, 1, 2].flatMap(() => pinch(r, ZOOM_IN));
    zs.forEach((z, i) => assert.ok(z > WALL_Z, `step ${i}: camera at z ${z} is at or behind the wall`));
    for (let i = 1; i < zs.length; i++) assert.ok(zs[i] <= zs[i - 1], `step ${i} moved away from the wall`);
    assert.ok(zs[zs.length - 1] - WALL_Z < 0.1, `${zs.length} steps got close to the wall: z ${zs[zs.length - 1]}`);
  });

  it('raycasts once per pinch, at the pinch midpoint in CSS px', () => {
    const r = rig();
    pinch(r, ZOOM_IN);
    assert.deepEqual(r.raycasts, [[CX, CY]]);
    pinch(r, ZOOM_IN);
    assert.equal(r.raycasts.length, 2, 'a new pinch picks afresh');
  });

  it('never raycasts for a zoom-out pinch, which cannot pass through anything', () => {
    const r = rig();
    pinch(r, ZOOM_OUT);
    assert.ok(r.camera.getPosition().z > 10, 'the ZOOM_OUT pinch must zoom out (#5777)');
    assert.equal(r.raycasts.length, 0);
  });

  it('re-picks after a zoom-out step moved the camera off the picked ray within one pinch', () => {
    const r = rig();
    pinch(r, [320, 360, 400, 360, 400]); // in, in, out, in (#5777: spreading zooms in)
    assert.equal(r.raycasts.length, 2, 'a point picked before the plain zoom-out step was reused');
  });

  it('skips the raycast while streaming, above the orbit-pivot census limit, and with a robust anchor', () => {
    for (const [label, opts] of [
      ['streaming', { isStreaming: true }],
      ['large model', { entities: 1_000_000 }],
      ['robust orbit anchor', { robustAnchor: true }],
    ] as const) {
      const r = rig(opts);
      const zs = pinch(r, ZOOM_IN);
      assert.equal(r.raycasts.length, 0, label);
      assert.ok(zs[zs.length - 1] < 10, `${label}: the pinch still zooms (plain)`);
      cleanup();
    }
  });
});
