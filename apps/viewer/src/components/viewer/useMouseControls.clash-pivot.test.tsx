/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Orbiting while a clash is focused turns around the clashing pair (#4806).
 *
 * The reporter: "When I am inspecting the clashes and I want to rotate the
 * view I get a wrong pivot. It should be placed near the collided objects."
 * A drag picks its pivot at pointer-down: the geometry under the cursor, else
 * the selected entity, else the scene centre. `focusClash` clears the
 * selection on purpose, and on a large or outlier model the cursor raycast is
 * skipped, so the orbit turned around the whole model's centre.
 *
 * These mount the real hook with a real `Camera`, drag, and measure the orbit.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Camera, type Renderer } from '@ifc-lite/renderer';
import { summarizeClashes, type Clash } from '@ifc-lite/clash';
import { useViewerStore } from '@/store';
import { useMouseControls, type UseMouseControlsParams, type MouseState } from './useMouseControls.js';
import { ViewportOverlays } from './ViewportOverlays.js';
import { projectToCssScreen } from '@/utils/projectScreen.js';

type Vec3 = { x: number; y: number; z: number };

const ref = <T,>(current: T) => ({ current });
const noop = () => {};

/** Overlap box of the focused clash, well away from the scene centre and the cursor hit. */
const CLASH: Clash = {
  id: 'clash-1',
  a: { key: 'a', ref: 11, model: 'm', tag: 'IfcPipeSegment' },
  b: { key: 'b', ref: 22, model: 'm', tag: 'IfcBeam' },
  rule: 'all-clashes',
  status: 'hard',
  distance: -0.05,
  point: [12, 3, -7],
  bounds: { min: [11, 2, -8], max: [13, 4, -6] },
  severity: 'major',
};
const CLASH_CENTRE: Vec3 = { x: 12, y: 3, z: -7 };
/** Where the cursor raycast lands (some other element under the pointer). */
const HIT: Vec3 = { x: -20, y: 0, z: 5 };
/** Scene bounds centred on the origin. */
const SCENE = { min: { x: -50, y: -5, z: -50 }, max: { x: 50, y: 5, z: 50 } };

function pointer(type: string, x: number, y: number, button = 0): PointerEvent {
  const e = new PointerEvent(type, { button, pointerId: 1, bubbles: true, cancelable: true });
  Object.defineProperties(e, { clientX: { value: x, configurable: true }, clientY: { value: y, configurable: true } });
  return e;
}

const mounted: { root: Root; host: HTMLElement }[] = [];

function mount(opts: { selectedEntityId?: number | null; outlierAnchor?: boolean; withOverlay?: boolean } = {}): {
  canvas: HTMLCanvasElement;
  camera: Camera;
  pivots: (Vec3 | null)[];
  host: HTMLElement;
} {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300 }) as DOMRect;
  Object.assign(canvas, { setPointerCapture: noop, releasePointerCapture: noop });
  document.body.appendChild(canvas);

  const camera = new Camera();
  camera.setPosition(30, 25, 40);
  camera.setTarget(0, 0, 0);
  camera.setSceneBounds(SCENE);
  if (opts.outlierAnchor) camera.setOrbitAnchorBounds(SCENE);
  const pivots: (Vec3 | null)[] = [];
  const setOrbitCenter = camera.setOrbitCenter.bind(camera);
  camera.setOrbitCenter = (c) => {
    pivots.push(c ? { ...c } : null);
    setOrbitCenter(c);
  };

  const renderer = {
    getCamera: () => camera,
    getScene: () => ({ getMeshes: () => [], getBatchedMeshes: () => [], getInstancedEntityCount: () => 0 }),
    raycastScene: () => ({ intersection: { point: { ...HIT } } }),
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
    selectedEntityIdRef: ref<number | null>(opts.selectedEntityId ?? null), selectedModelIndexRef: ref(undefined),
    clearColorRef: ref<[number, number, number, number]>([0, 0, 0, 1]),
    sectionPlaneRef: ref(state.sectionPlane), sectionRangeRef: ref(null), geometryRef: ref(null),
    measureRaycastPendingRef: ref(false), measureRaycastFrameRef: ref(null),
    lastMeasureRaycastDurationRef: ref(0), lastHoverSnapTimeRef: ref(0), lastHoverCheckRef: ref(0),
    hoverTooltipsEnabledRef: ref(false), lastRenderTimeRef: ref(0), renderPendingRef: ref(false),
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
    RENDER_THROTTLE_MS_SMALL: 16, RENDER_THROTTLE_MS_LARGE: 33, RENDER_THROTTLE_MS_HUGE: 66,
    fastZoomRef: ref(false),
  } satisfies UseMouseControlsParams;

  function Probe() {
    useMouseControls(params);
    return opts.withOverlay ? <ViewportOverlays hideViewCube hideAxis hideScale /> : null;
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<Probe />));
  mounted.push({ root, host });
  return { canvas, camera, pivots, host };
}

function focusClash(): void {
  useViewerStore.setState({
    clashResult: {
      clashes: [CLASH],
      summary: summarizeClashes([CLASH]),
      rulesRun: [],
      settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
    },
    clashSelectedId: CLASH.id,
  });
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Orbit-drag and report how far the camera sits from `p` before and after. */
function orbitDrag(canvas: HTMLCanvasElement, camera: Camera, p: Vec3): { before: number; after: number; moved: number } {
  const start = camera.getPosition();
  canvas.dispatchEvent(pointer('pointerdown', 400, 300));
  canvas.dispatchEvent(pointer('pointermove', 470, 330));
  canvas.dispatchEvent(pointer('pointerup', 470, 330));
  const end = camera.getPosition();
  return { before: dist(start, p), after: dist(end, p), moved: dist(start, end) };
}

describe('useMouseControls orbit pivot while a clash is focused (#4806)', () => {
  afterEach(() => {
    while (mounted.length) {
      const { root, host } = mounted.pop()!;
      act(() => root.unmount());
      host.remove();
    }
    document.body.innerHTML = '';
    useViewerStore.getState().clearClashFocus();
    useViewerStore.setState({ clashResult: null });
  });

  it('orbits around the clashing pair, not the geometry under the cursor', () => {
    focusClash();
    const { canvas, camera, pivots } = mount();
    const orbit = orbitDrag(canvas, camera, CLASH_CENTRE);
    assert.deepEqual(pivots.at(-1), CLASH_CENTRE, 'BUG: the orbit pivot is not the focused clash centre');
    assert.ok(orbit.moved > 1, 'the drag really orbited the camera');
    assert.ok(
      Math.abs(orbit.after - orbit.before) < 1e-6,
      `the camera keeps its distance to the clash (${orbit.before} -> ${orbit.after})`,
    );
  });

  it('orbits around the clashing pair on a large/outlier model, not the model centre', () => {
    focusClash();
    const { canvas, camera, pivots } = mount({ outlierAnchor: true });
    orbitDrag(canvas, camera, CLASH_CENTRE);
    assert.deepEqual(pivots.at(-1), CLASH_CENTRE, 'BUG: the orbit turned around the whole model centre');
  });

  it('keeps pick-to-pivot when no clash is focused', () => {
    const { canvas, camera, pivots } = mount();
    const orbit = orbitDrag(canvas, camera, HIT);
    assert.deepEqual(pivots.at(-1), HIT, 'the pivot is the geometry under the cursor');
    assert.ok(Math.abs(orbit.after - orbit.before) < 1e-6);
  });

  it('publishes the picked pivot for orbit only, and clears it on drag end (#5891)', () => {
    const { canvas, camera, host } = mount({ withOverlay: true });
    const marker = host.querySelector<HTMLElement>('[data-orbit-pivot-marker]');
    assert.ok(marker, 'the viewport renders a pivot marker');
    assert.equal(marker.getAttribute('aria-hidden'), 'true');
    assert.match(marker.className, /pointer-events-none/);
    assert.match(marker.className, /opacity-0/);

    act(() => { canvas.dispatchEvent(pointer('pointerdown', 200, 150)); });
    assert.match(marker.className, /opacity-100/);
    const projected = projectToCssScreen(camera, canvas, HIT);
    assert.ok(projected);
    assert.ok(Math.abs(parseFloat(marker.style.left) - projected.x) < 0.001,
      'the marker uses the pivot projection in CSS pixels');
    assert.ok(Math.abs(parseFloat(marker.style.top) - projected.y) < 0.001,
      'the marker uses the pivot projection in CSS pixels');
    act(() => { canvas.dispatchEvent(pointer('pointerup', 200, 150)); });
    assert.match(marker.className, /opacity-0/);

    act(() => { canvas.dispatchEvent(pointer('pointerdown', 200, 150, 1)); });
    assert.match(marker.className, /opacity-0/, 'middle-button pan does not show an orbit marker');
    act(() => { canvas.dispatchEvent(pointer('pointerup', 200, 150, 1)); });

    act(() => { canvas.dispatchEvent(pointer('pointerdown', 200, 150)); });
    assert.match(marker.className, /opacity-100/);
    act(() => { canvas.dispatchEvent(pointer('pointercancel', 200, 150)); });
    assert.match(marker.className, /opacity-0/, 'cancelled gestures release the marker');
  });

  it('keeps pick-to-pivot once the user selects something while the clash stays focused', () => {
    focusClash();
    const { canvas, camera, pivots } = mount({ selectedEntityId: 99 });
    orbitDrag(canvas, camera, HIT);
    assert.deepEqual(pivots.at(-1), HIT);
  });

  it('returns to normal navigation after the clash is unfocused', () => {
    focusClash();
    const { canvas, camera, pivots } = mount();
    orbitDrag(canvas, camera, CLASH_CENTRE);
    useViewerStore.getState().clearClashFocus();
    orbitDrag(canvas, camera, HIT);
    assert.deepEqual(pivots.at(-1), HIT);
  });

  it('keeps the outlier-model centre fallback when no clash is focused (#1394)', () => {
    const { canvas, camera, pivots } = mount({ outlierAnchor: true });
    orbitDrag(canvas, camera, { x: 0, y: 0, z: 0 });
    assert.deepEqual(pivots.at(-1), { x: 0, y: 0, z: 0 });
  });
});
