/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8769: on a large model the orbit-start CPU raycast is gated off (#1716,
 * orbitPivotCensus.ts), so the pivot fell back to the scene centre, a long
 * lever arm when zoomed into a local detail. The pivot now comes from the
 * last frame's depth under the cursor (`Renderer.probeSurface`), primed by
 * the hover, or adopted a frame after the press if the camera has not moved.
 *
 * Mounts the real hook with a real `Camera` over a ground plane z = 0.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Camera, type Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { useMouseControls, type UseMouseControlsParams, type MouseState } from './useMouseControls.js';
import { PIVOT_RAYCAST_MAX_INDICES } from './orbitPivotCensus.js';

type Vec3 = { x: number; y: number; z: number };

const ref = <T,>(current: T) => ({ current });
const noop = () => {};
const W = 400, H = 300;

function pointer(type: string, x: number, y: number, button = 0): PointerEvent {
  const e = new PointerEvent(type, { button, pointerId: 1, bubbles: true, cancelable: true });
  Object.defineProperties(e, { clientX: { value: x, configurable: true }, clientY: { value: y, configurable: true } });
  return e;
}

const frame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const mounted: { root: Root; host: HTMLElement }[] = [];

function mount(opts: { small?: boolean } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: W, height: H }) as DOMRect;
  Object.assign(canvas, { setPointerCapture: noop, releasePointerCapture: noop });
  document.body.appendChild(canvas);

  const camera = new Camera();
  camera.setAspect(W / H);
  camera.setPosition(0, -1600, 1200);
  camera.setTarget(0, 0, 0);
  camera.setSceneBounds({ min: { x: -1500, y: -1500, z: -5 }, max: { x: 1500, y: 1500, z: 30 } });
  const pivots: (Vec3 | null)[] = [];
  const setOrbitCenter = camera.setOrbitCenter.bind(camera);
  camera.setOrbitCenter = (c) => {
    pivots.push(c ? { ...c } : null);
    setOrbitCenter(c);
  };
  const ground = (x: number, y: number): Vec3 | null => {
    const ray = camera.unprojectToRay(x, y, W, H);
    if (!(ray.direction.z < 0)) return null;
    const t = -ray.origin.z / ray.direction.z;
    return { x: ray.origin.x + ray.direction.x * t, y: ray.origin.y + ray.direction.y * t, z: 0 };
  };
  const raycasts: Array<[number, number]> = [];
  const probes: Array<[number, number]> = [];
  const heavy = { expressIds: [1, 2, 3], indexCount: PIVOT_RAYCAST_MAX_INDICES + 1 };
  const renderer = {
    getCamera: () => camera,
    getCanvas: () => canvas,
    getScene: () => ({ getMeshes: () => [], getBatchedMeshes: () => (opts.small ? [] : [heavy]), getInstancedEntityCount: () => 0 }),
    raycastScene: (x: number, y: number) => { raycasts.push([x, y]); const p = ground(x, y); return p ? { intersection: { point: p } } : null; },
    probeSurface: async (x: number, y: number) => { probes.push([x, y]); return ground(x, y); },
    requestRender: noop,
    pick: async () => null,
    pickRect: async () => [],
  } as unknown as Renderer;
  const state = useViewerStore.getState();

  const params = {
    canvasRef: ref(canvas), rendererRef: ref(renderer), isInitialized: true,
    mouseStateRef: ref<MouseState>({ isDragging: false, isPanning: false, lastX: 0, lastY: 0, button: 0, startX: 0, startY: 0, didDrag: false }),
    activeToolRef: ref('select'), activeMeasurementRef: ref(null), snapEnabledRef: ref(false),
    edgeLockStateRef: ref(state.edgeLockState), measurementConstraintEdgeRef: ref(null),
    sectionPickModeRef: ref(false), modelBoundsRef: ref(null),
    hiddenEntitiesRef: ref(new Set<number>()), isolatedEntitiesRef: ref(null),
    selectedEntityIdRef: ref<number | null>(null), selectedModelIndexRef: ref(undefined),
    clearColorRef: ref<[number, number, number, number]>([0, 0, 0, 1]),
    sectionPlaneRef: ref(state.sectionPlane), sectionRangeRef: ref(null), geometryRef: ref(null),
    measureRaycastPendingRef: ref(false), measureRaycastFrameRef: ref(null),
    lastMeasureRaycastDurationRef: ref(0), lastHoverSnapTimeRef: ref(0), lastHoverCheckRef: ref(0),
    hoverTooltipsEnabledRef: ref(false),
    isInteractingRef: ref(false), lastClickTimeRef: ref(0), lastClickPosRef: ref(null), lastCameraStateRef: ref(null),
    handlePickForSelection: noop, setHoverState: noop, clearHover: noop, openContextMenu: noop,
    startMeasurement: noop, updateMeasurement: noop, finalizeMeasurement: noop,
    setSnapTarget: noop, setSnapVisualization: noop, setEdgeLock: noop, updateEdgeLockPosition: noop,
    clearEdgeLock: noop, incrementEdgeLockStrength: noop, setMeasurementConstraintEdge: noop,
    updateConstraintActiveAxis: noop, updateMeasurementScreenCoords: noop, updateCameraRotationRealtime: noop,
    toggleSelection: noop, calculateScale: noop,
    getPickOptions: () => ({ isStreaming: false, hiddenIds: new Set<number>(), isolatedIds: null }),
    hasPendingMeasurements: () => false, setSectionPlaneFromFace: noop, setSectionPickMode: noop, setSectionPickPreview: noop,
    HOVER_SNAP_THROTTLE_MS: 50, SLOW_RAYCAST_THRESHOLD_MS: 50, hoverThrottleMs: 50,
    fastZoomRef: ref(false),
  } satisfies UseMouseControlsParams;

  function Probe() {
    useMouseControls(params);
    return null;
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<Probe />));
  mounted.push({ root, host });
  return { canvas, camera, pivots, raycasts, probes, ground };
}

const near = (a: Vec3 | null | undefined, b: Vec3 | null, tol = 1e-3) =>
  !!a && !!b && Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < tol;

describe('orbit pivot from the depth under the cursor on a large model (#8769)', () => {
  const realRaf = globalThis.requestAnimationFrame;
  beforeEach(() => { globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0)) as typeof requestAnimationFrame; });
  afterEach(() => {
    globalThis.requestAnimationFrame = realRaf;
    while (mounted.length) {
      const { root, host } = mounted.pop()!;
      act(() => root.unmount());
      host.remove();
    }
    document.body.innerHTML = '';
  });

  it('pivots on the surface the hover probed, not the scene centre', async () => {
    const m = mount();
    const under = m.ground(300, 220);
    m.canvas.dispatchEvent(pointer('pointermove', 300, 220));
    await frame();
    m.canvas.dispatchEvent(pointer('pointerdown', 300, 220));
    assert.ok(near(m.pivots.at(-1), under), `BUG: pivot ${JSON.stringify(m.pivots.at(-1))} is not the ground under the cursor ${JSON.stringify(under)}`);
    m.canvas.dispatchEvent(pointer('pointerup', 300, 220));
    assert.equal(m.raycasts.length, 0, 'the CPU raycast stays gated off');
  });

  it('adopts the probe a frame after a press with no hover, while the press is still a click', async () => {
    const m = mount();
    const under = m.ground(120, 200);
    m.canvas.dispatchEvent(pointer('pointerdown', 120, 200));
    assert.ok(!near(m.pivots.at(-1), under), 'nothing probed yet: the fallback pivot');
    await frame();
    await frame();
    assert.ok(near(m.pivots.at(-1), under), `pivot ${JSON.stringify(m.pivots.at(-1))} adopted the probed ground`);
    const before = m.camera.getPosition();
    m.canvas.dispatchEvent(pointer('pointermove', 190, 230));
    m.canvas.dispatchEvent(pointer('pointerup', 190, 230));
    const after = m.camera.getPosition();
    const r = (p: Vec3) => Math.hypot(p.x - under!.x, p.y - under!.y, p.z - under!.z);
    assert.ok(Math.abs(r(after) - r(before)) < 1e-3, 'the orbit turned around the adopted pivot');
  });

  it('does not move the pivot under a drag that already started', async () => {
    const m = mount();
    m.canvas.dispatchEvent(pointer('pointerdown', 120, 200));
    m.canvas.dispatchEvent(pointer('pointermove', 190, 230)); // past the drag threshold: orbiting
    const count = m.pivots.length;
    await frame();
    assert.equal(m.pivots.length, count, 'a late probe never re-pivots a running orbit');
    m.canvas.dispatchEvent(pointer('pointerup', 190, 230));
  });

  it('keeps the CPU raycast pivot on a small model, with no depth reads', async () => {
    const m = mount({ small: true });
    m.canvas.dispatchEvent(pointer('pointermove', 300, 220));
    await frame();
    m.canvas.dispatchEvent(pointer('pointerdown', 300, 220));
    assert.ok(near(m.pivots.at(-1), m.ground(300, 220)));
    assert.equal(m.raycasts.length, 1);
    assert.equal(m.probes.length, 0);
    m.canvas.dispatchEvent(pointer('pointerup', 300, 220));
  });
});
