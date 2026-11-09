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
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useMouseControls, type UseMouseControlsParams, type MouseState } from './useMouseControls.js';
import { installManualFrames, type ManualFrames } from '@/test/manual-frames.js';

const NOTCH_DELTA_Y = 120;

/**
 * happy-dom's `WheelEvent` implements only the delta half of the init dict, so
 * `ctrlKey` and `clientX` have to be defined explicitly - a browser supplies
 * both. Same reasoning as in `wheelZoom.test.ts`; without it the ctrl cases
 * would quietly test the unmodified path.
 */
function wheelEvent(init: { ctrlKey?: boolean; deltaX?: number; deltaY?: number } = {}): WheelEvent {
  const e = new WheelEvent('wheel', {
    deltaX: init.deltaX ?? 0,
    deltaY: init.deltaY ?? NOTCH_DELTA_Y,
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

function makeParams(
  canvas: HTMLCanvasElement,
  camera: Camera,
  rendererExtras: Record<string, unknown> = {},
  isStreaming = false,
): UseMouseControlsParams {
  const renderer = {
    getCamera: () => camera,
    requestRender: noop,
    pick: () => null,
    pickRect: () => [],
    ...rendererExtras,
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
    getPickOptions: () => ({ isStreaming, hiddenIds: new Set<number>(), isolatedIds: null }),
    hasPendingMeasurements: () => false,
    setSectionPlaneFromFace: noop,
    setSectionPickMode: noop,
    setSectionPickPreview: noop,
    HOVER_SNAP_THROTTLE_MS: 50,
    SLOW_RAYCAST_THRESHOLD_MS: 50,
    hoverThrottleMs: 50,
    fastZoomRef: ref(false),
  };
}

const mounted: { root: Root; host: HTMLDivElement }[] = [];

/** Mounts the hook against a canvas and returns both. */
function mountViewport(
  rendererExtras: Record<string, unknown> = {},
  isStreaming = false,
): { canvas: HTMLCanvasElement; camera: Camera } {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  document.body.appendChild(canvas);

  const camera = new Camera();
  const params = makeParams(canvas, camera, rendererExtras, isStreaming);

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

/** Camera travel produced by one dispatched wheel event, in the event itself. */
function travelOf(canvas: HTMLCanvasElement, camera: Camera, e: WheelEvent): number {
  const before = { ...camera.getPosition() };
  canvas.dispatchEvent(e);
  const after = camera.getPosition();
  return Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
}

/** Frames run by hand, so an eased zoom (#9507) settles when the test says. */
let frames: ManualFrames;
const settle = () => { frames.flush(); };

/** Camera travel once the zoom one dispatched wheel event started has settled. */
function settledTravelOf(canvas: HTMLCanvasElement, camera: Camera, e: WheelEvent): number {
  const before = { ...camera.getPosition() };
  canvas.dispatchEvent(e);
  settle();
  const after = camera.getPosition();
  return Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
}

describe('useMouseControls wheel zoom - registration and wiring (#2683)', () => {
  beforeEach(() => {
    // No stray Control from a previous test: the tracker listens on window.
    window.dispatchEvent(new Event('blur'));
    frames = installManualFrames();
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
    useViewerStore.setState({ navigationPreset: 'default' });
    frames.restore();
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
    const pinch = settledTravelOf(pinchView.canvas, pinchView.camera, wheelEvent({ ctrlKey: true, deltaY: 30 }));

    const plainView = mountViewport();
    const plain = settledTravelOf(plainView.canvas, plainView.camera, wheelEvent({ deltaY: 30 }));

    assert.ok(Math.abs(pinch - plain) < 1e-9, `pinch-zoom must keep its usual speed: ${pinch} vs ${plain}`);
  });

  it('eases a notch: a slice lands in the event and the rest over the next frames (#9507)', () => {
    const { canvas, camera } = mountViewport();
    const reference = new Camera();
    reference.zoom(NOTCH_DELTA_Y, false, 400, 300, 800, 600, false);
    const notch = reference.getDistance() - new Camera().getDistance();

    const startDistance = camera.getDistance();
    canvas.dispatchEvent(wheelEvent());
    const first = camera.getDistance() - startDistance;
    assert.ok(first > 0, 'the zoom starts in the event itself');
    assert.ok(first < notch * 0.5, `the event moved ${first} of a ${notch} notch: that is a jump, not an ease`);

    assert.ok(frames.pending() > 0, 'the rest is queued for the next frame');
    settle();
    const total = camera.getDistance() - startDistance;
    // Within 6 %: compounding the slices zooms exp(-0.1) where one step zooms 0.9.
    assert.ok(Math.abs(total - notch) / notch < 0.06, `the eased notch lands where one notch does: ${total} vs ${notch}`);
  });

  it('an orbit during an eased zoom drops the rest of it (#9507)', () => {
    const { canvas, camera } = mountViewport();
    canvas.dispatchEvent(wheelEvent());
    camera.orbit(40, 0, false);
    const afterOrbit = camera.getDistance();
    settle();
    assert.equal(camera.getDistance(), afterOrbit, 'the zoom did not resume after the orbit');
  });

  it('zooms further with the Fast sensitivity and less with Slow (#9507)', () => {
    const travelAt = (wheelZoomSensitivity: 'slow' | 'normal' | 'fast') => {
      useViewerStore.setState({ wheelZoomSensitivity });
      const view = mountViewport();
      return settledTravelOf(view.canvas, view.camera, wheelEvent({ deltaY: 40 }));
    };
    try {
      const slow = travelAt('slow');
      const normal = travelAt('normal');
      const fast = travelAt('fast');
      assert.ok(slow < normal && normal < fast, `slow ${slow} < normal ${normal} < fast ${fast}`);
    } finally {
      useViewerStore.setState({ wheelZoomSensitivity: 'normal' });
    }
  });

  it('applies the whole notch in the event under prefers-reduced-motion (#9507)', () => {
    const original = window.matchMedia;
    const reduce = (query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query }) as MediaQueryList;
    Object.defineProperty(window, 'matchMedia', { value: reduce, configurable: true, writable: true });
    try {
      const { canvas, camera } = mountViewport();
      const reference = new Camera();
      reference.zoom(NOTCH_DELTA_Y, false, 400, 300, 800, 600, false);
      canvas.dispatchEvent(wheelEvent());
      assert.ok(Math.abs(camera.getDistance() - reference.getDistance()) < 1e-9,
        `reduced motion: ${camera.getDistance()} vs one notch ${reference.getDistance()}`);
    } finally {
      Object.defineProperty(window, 'matchMedia', { value: original, configurable: true, writable: true });
    }
  });

  for (const modelCount of [1, 2]) {
    it(`trackpad wheel pans the camera without zooming across ${modelCount} model(s) (#5889)`, () => {
      const previous = useViewerStore.getState();
      const models = Array.from({ length: modelCount }, (_, i) => fixtureModel(`m-${i}`, { idOffset: i * 1_000_000 }));
      useViewerStore.setState({ ...fixtureModels(...models), navigationPreset: 'trackpad' });
      try {
        const { canvas, camera } = mountViewport();
        const target = camera.getTarget();
        const distance = camera.getDistance();
        const pan = wheelEvent({ deltaX: 30, deltaY: 0 });
        canvas.dispatchEvent(pan);
        assert.equal(pan.defaultPrevented, true);
        assert.notDeepEqual(camera.getTarget(), target, 'horizontal swipe must pan');
        assert.equal(camera.getDistance(), distance, 'pan preserves orbit distance');

        const pinch = wheelEvent({ ctrlKey: true, deltaY: 120 });
        canvas.dispatchEvent(pinch);
        assert.notEqual(camera.getDistance(), distance, 'Ctrl + wheel must zoom');
      } finally {
        useViewerStore.setState({ models: previous.models, activeModelId: previous.activeModelId, navigationPreset: previous.navigationPreset });
      }
    });
  }
});

describe('useMouseControls wheel zoom - surface pick gate (#5393)', () => {
  afterEach(() => {
    while (mounted.length > 0) {
      const { root, host } = mounted.pop()!;
      act(() => {
        root.unmount();
      });
      host.remove();
    }
    document.body.innerHTML = '';
  });

  /** A census-shaped scene: `entities` instanced entities, nothing batched. */
  const scene = (entities: number) => ({ getMeshes: () => [], getBatchedMeshes: () => [], getInstancedEntityCount: () => entities });

  /** Mount, dispatch one zoom-IN notch, return how many raycasts ran. */
  function raycastsForOneZoomIn(entities: number, isStreaming: boolean, robustAnchor: boolean): number {
    let raycasts = 0;
    const { canvas, camera } = mountViewport({
      getScene: () => scene(entities),
      raycastScene: () => { raycasts++; return null; },
    }, isStreaming);
    if (robustAnchor) camera.setOrbitAnchorBounds({ min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } });
    const e = wheelEvent();
    Object.defineProperty(e, 'deltaY', { value: -NOTCH_DELTA_Y, configurable: true });
    canvas.dispatchEvent(e);
    return raycasts;
  }

  it('raycasts the surface under the cursor on a small, loaded model', () => {
    assert.equal(raycastsForOneZoomIn(10, false, false), 1);
  });

  it('skips the raycast while streaming, above the orbit-pivot census limit, and with a robust anchor', () => {
    assert.equal(raycastsForOneZoomIn(10, true, false), 0, 'streaming');
    assert.equal(raycastsForOneZoomIn(1_000_000, false, false), 0, 'large model');
    assert.equal(raycastsForOneZoomIn(10, false, true), 0, 'robust orbit anchor');
  });
});
