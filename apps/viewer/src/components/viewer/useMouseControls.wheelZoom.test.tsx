/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2683 - the wheel path as the canvas actually sees it.
 *
 * `wheelZoom.test.ts` covers the step maths in isolation. This file mounts the
 * real hook and dispatches a real wheel event at the real canvas, because two
 * things can only break here:
 *
 *  - the listener registration. Ctrl+wheel is the browser's page-zoom
 *    shortcut, and `preventDefault()` from a PASSIVE listener does nothing -
 *    the page would zoom instead of the model. happy-dom models that faithfully
 *    (a passive listener leaves `defaultPrevented` false), so flipping
 *    `{ passive: false }` here turns this file red.
 *  - the wiring. A handler that computes a fine step and then hands the raw
 *    delta to the camera would pass every unit test in the other file.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Camera, type Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { useMouseControls, type UseMouseControlsParams, type MouseState } from './useMouseControls.js';

const NOTCH_DELTA_Y = 120;

/**
 * happy-dom's `WheelEvent` implements only the delta half of the init dict, so
 * `ctrlKey` and `clientX` have to be defined explicitly - a browser supplies
 * both. Same reasoning as in `wheelZoom.test.ts`; without it the ctrl cases
 * would quietly test the unmodified path.
 */
function wheelEvent(init: { ctrlKey?: boolean } = {}): WheelEvent {
  const e = new WheelEvent('wheel', {
    deltaY: NOTCH_DELTA_Y,
    deltaMode: 0,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperties(e, {
    ctrlKey: { value: init.ctrlKey ?? false, configurable: true },
    metaKey: { value: false, configurable: true },
    clientX: { value: 400, configurable: true },
    clientY: { value: 300, configurable: true },
  });
  return e;
}

const ref = <T,>(current: T) => ({ current });
const noop = () => {};

function makeParams(canvas: HTMLCanvasElement, camera: Camera): UseMouseControlsParams {
  const renderer = {
    getCamera: () => camera,
    requestRender: noop,
    pick: () => null,
    pickRect: () => [],
  } as unknown as Renderer;

  const state = useViewerStore.getState();

  return {
    canvasRef: ref<HTMLCanvasElement | null>(canvas),
    rendererRef: ref<Renderer | null>(renderer),
    isInitialized: true,
    mouseStateRef: ref<MouseState>({
      isDragging: false,
      isPanning: false,
      lastX: 0,
      lastY: 0,
      button: 0,
      startX: 0,
      startY: 0,
      didDrag: false,
    }),
    activeToolRef: ref('select'),
    activeMeasurementRef: ref(null),
    snapEnabledRef: ref(false),
    edgeLockStateRef: ref(state.edgeLockState),
    measurementConstraintEdgeRef: ref(null),
    sectionPickModeRef: ref(false),
    modelBoundsRef: ref(null),
    hiddenEntitiesRef: ref(new Set<number>()),
    isolatedEntitiesRef: ref<Set<number> | null>(null),
    selectedEntityIdRef: ref<number | null>(null),
    selectedModelIndexRef: ref<number | undefined>(undefined),
    clearColorRef: ref<[number, number, number, number]>([0, 0, 0, 1]),
    sectionPlaneRef: ref(state.sectionPlane),
    sectionRangeRef: ref(null),
    geometryRef: ref(null),
    measureRaycastPendingRef: ref(false),
    measureRaycastFrameRef: ref<number | null>(null),
    lastMeasureRaycastDurationRef: ref(0),
    lastHoverSnapTimeRef: ref(0),
    lastHoverCheckRef: ref(0),
    hoverTooltipsEnabledRef: ref(false),
    lastRenderTimeRef: ref(0),
    renderPendingRef: ref(false),
    isInteractingRef: ref(false),
    lastClickTimeRef: ref(0),
    lastClickPosRef: ref(null),
    lastCameraStateRef: ref(null),
    handlePickForSelection: noop,
    setHoverState: noop,
    clearHover: noop,
    openContextMenu: noop,
    startMeasurement: noop,
    updateMeasurement: noop,
    finalizeMeasurement: noop,
    setSnapTarget: noop,
    setSnapVisualization: noop,
    setEdgeLock: noop,
    updateEdgeLockPosition: noop,
    clearEdgeLock: noop,
    incrementEdgeLockStrength: noop,
    setMeasurementConstraintEdge: noop,
    updateConstraintActiveAxis: noop,
    updateMeasurementScreenCoords: noop,
    updateCameraRotationRealtime: noop,
    toggleSelection: noop,
    calculateScale: noop,
    getPickOptions: () => ({ isStreaming: false, hiddenIds: new Set<number>(), isolatedIds: null }),
    hasPendingMeasurements: () => false,
    setSectionPlaneFromFace: noop,
    setSectionPickMode: noop,
    setSectionPickPreview: noop,
    HOVER_SNAP_THROTTLE_MS: 50,
    SLOW_RAYCAST_THRESHOLD_MS: 50,
    hoverThrottleMs: 50,
    RENDER_THROTTLE_MS_SMALL: 16,
    RENDER_THROTTLE_MS_LARGE: 33,
    RENDER_THROTTLE_MS_HUGE: 66,
    fastZoomRef: ref(false),
  };
}

const mounted: { root: Root; host: HTMLDivElement }[] = [];

/** Mounts the hook against a canvas and returns both. */
function mountViewport(): { canvas: HTMLCanvasElement; camera: Camera } {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  document.body.appendChild(canvas);

  const camera = new Camera();
  const params = makeParams(canvas, camera);

  function Probe() {
    useMouseControls(params);
    return null;
  }

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<Probe />);
  });
  mounted.push({ root, host });

  return { canvas, camera };
}

/** Camera travel produced by one dispatched wheel event. */
function travelOf(canvas: HTMLCanvasElement, camera: Camera, e: WheelEvent): number {
  const before = { ...camera.getPosition() };
  canvas.dispatchEvent(e);
  const after = camera.getPosition();
  return Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
}

describe('useMouseControls wheel zoom - registration and wiring (#2683)', () => {
  beforeEach(() => {
    // No stray Control from a previous test: the tracker listens on window.
    window.dispatchEvent(new Event('blur'));
  });

  afterEach(() => {
    // Unmount every mount: each one added a window key listener that would
    // otherwise keep answering for the next test.
    while (mounted.length > 0) {
      const { root, host } = mounted.pop()!;
      act(() => {
        root.unmount();
      });
      host.remove();
    }
    document.body.innerHTML = '';
  });

  it('cancels the browser default on a ctrl+wheel, so the page does not zoom', () => {
    const { canvas } = mountViewport();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));

    const e = wheelEvent({ ctrlKey: true });
    canvas.dispatchEvent(e);

    assert.equal(
      e.defaultPrevented,
      true,
      'a passive listener cannot cancel this, and the browser would page-zoom instead',
    );
  });

  it('cancels the browser default on a plain wheel too', () => {
    const { canvas } = mountViewport();
    const e = wheelEvent();
    canvas.dispatchEvent(e);
    assert.equal(e.defaultPrevented, true);
  });

  it('zooms a real Ctrl+wheel FINER than the same unmodified notch', () => {
    const plainView = mountViewport();
    const plain = travelOf(plainView.canvas, plainView.camera, wheelEvent());

    // A genuine key press, which is what separates a held Ctrl from a pinch.
    // Dispatched AFTER the mount, as it is in life: the viewport is already
    // listening when the user reaches for the key.
    const fineView = mountViewport();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
    const fine = travelOf(fineView.canvas, fineView.camera, wheelEvent({ ctrlKey: true }));

    assert.ok(plain > 0, 'the unmodified notch must move the camera');
    assert.ok(fine > 0, 'the fine notch must still move the camera');
    assert.ok(fine < plain, `ctrl travel ${fine} should be smaller than plain travel ${plain}`);
  });

  it('leaves a pinch (ctrlKey, no key pressed) at the normal step', () => {
    const pinchView = mountViewport();
    const pinch = travelOf(pinchView.canvas, pinchView.camera, wheelEvent({ ctrlKey: true }));

    const plainView = mountViewport();
    const plain = travelOf(plainView.canvas, plainView.camera, wheelEvent());

    assert.equal(pinch, plain, 'pinch-zoom must keep its usual speed');
  });
});
