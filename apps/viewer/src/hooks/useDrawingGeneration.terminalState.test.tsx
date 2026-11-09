/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every drawing generation ends in a terminal state, including the ones that
 * never publish. A cut cancelled before it published (the last model removed,
 * the panel closed) used to return at its `isCurrent()` checkpoint without a
 * status write, and the queue's `cancel()` only bumped a revision, so the
 * store kept `drawing2DStatus: 'generating'`: the spinner overlay stayed up,
 * Regenerate stayed disabled and the BCF panel kept saying "still
 * generating". The BCF capture registry's pending flag had the same hole: it
 * was cleared only by a successful publish (#4802 follow-up).
 *
 * These drive the real hook and real cutter against the real store setters,
 * holding the cutter at its async boundary to cancel or supersede mid-cut.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Drawing2DGenerator, type Drawing2D } from '@ifc-lite/drawing-2d';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '../store/index.js';
import type { Drawing2DStatus } from '../store/slices/drawing2DSlice.js';
import {
  hasActiveDrawingCanvas,
  markActiveDrawingCanvasRendered,
  registerActiveDrawingCanvas,
} from '../lib/drawing/active-canvas-snapshot.js';
import { useDrawingGeneration } from './useDrawingGeneration.js';

function box(expressId: number, x0: number): MeshData {
  const [x1, y0, y1, z0, z1] = [x0 + 2, 0, 3, 0, 0.2];
  const positions = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
    3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
  ]);
  return {
    expressId, ifcType: 'IfcWall', modelIndex: 0, positions,
    normals: new Float32Array(positions.length), indices, color: [0.5, 0.5, 0.5, 1], geometryClass: 0,
  };
}

function geometry(firstId = 100): GeometryResult {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 6, y: 3, z: 0.2 } };
  return {
    meshes: [box(firstId, 0), box(firstId + 1, 4)],
    totalTriangles: 24,
    totalVertices: 16,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false },
  };
}

type Inputs = Omit<Parameters<typeof useDrawingGeneration>[0],
  'drawing' | 'setDrawing' | 'setDrawingStatus' | 'setDrawingProgress' | 'setDrawingError'>;

const BASE: Inputs = {
  geometryResult: null,
  ifcDataStore: null,
  sectionPlane: { axis: 'down', position: 50, flipped: false },
  displayOptions: {
    showHiddenLines: false, useSymbolicRepresentations: false, show3DOverlay: false,
    scale: 50, showConstructionProjection: false,
  },
  typeVisibility: { spaces: true, spatialZones: true, openings: true, virtualElements: true, site: true, ifcAnnotations: true },
  combinedHiddenIds: new Set(), combinedIsolatedIds: null, computedIsolatedIds: null,
  models: new Map([['m0', { id: 'm0', visible: true }]]),
  panelVisible: false,
  activeTool: 'select',
};

function Harness({ value }: { value: Inputs }): null {
  const drawing = useViewerStore((s) => s.drawing2D);
  const store = useViewerStore.getState();
  useDrawingGeneration({
    ...value, drawing,
    setDrawing: store.setDrawing2D,
    setDrawingStatus: store.setDrawing2DStatus,
    setDrawingProgress: store.setDrawing2DProgress,
    setDrawingError: store.setDrawing2DError,
  });
  return null;
}

/** Hold every cut at the cutter's async boundary until `release()`. */
function holdCutter() {
  const original = Drawing2DGenerator.prototype.generate;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const started: Array<() => void> = [];
  let calls = 0;
  Drawing2DGenerator.prototype.generate = async function (...args) {
    calls++;
    for (const notify of started.splice(0)) notify();
    await gate;
    return original.call(this, ...args);
  };
  return {
    get calls() { return calls; },
    nextStart() { return new Promise<void>((resolve) => started.push(resolve)); },
    /** Open the gate for this cut and every later one. */
    release() { open(); },
    restore() { open(); Drawing2DGenerator.prototype.generate = original; },
  };
}

let root: Root;
let container: HTMLElement;
let inputs: Inputs;
let statuses: Drawing2DStatus[];
let unsubscribe: () => void;
const cleanups: Array<() => void> = [];

async function render(patch: Partial<Inputs>): Promise<void> {
  inputs = { ...inputs, ...patch };
  await act(async () => { root.render(<Harness value={inputs} />); });
}

/** Let a released cut run through its microtask continuations to completion. */
async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
}

beforeEach(() => {
  useViewerStore.getState().clearDrawing2D();
  inputs = BASE;
  statuses = [];
  unsubscribe = useViewerStore.subscribe((state, previous) => {
    if (state.drawing2DStatus !== previous.drawing2DStatus) statuses.push(state.drawing2DStatus);
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await act(async () => root.unmount());
  container.remove();
  unsubscribe();
  useViewerStore.getState().clearDrawing2D();
});

/** What `Drawing2DCanvas` does when it mounts and paints `drawing`. */
function mountCanvasFor(drawing: Drawing2D): void {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  cleanups.push(registerActiveDrawingCanvas(canvas, drawing));
  markActiveDrawingCanvasRendered(canvas, drawing, true);
}

describe('useDrawingGeneration terminal state on cancel (D1, #3921 queue)', () => {
  it('returns a fresh model\'s first cut to idle when the last model is removed mid-cut', async () => {
    const cutter = holdCutter();
    try {
      const started = cutter.nextStart();
      await render({ geometryResult: geometry(), panelVisible: true });
      await act(async () => { await started; });
      assert.equal(useViewerStore.getState().drawing2DStatus, 'generating', 'the first cut raised the overlay');
      assert.equal(useViewerStore.getState().drawing2D, null, 'no earlier drawing exists to clear');

      await render({ geometryResult: null });
      assert.equal(useViewerStore.getState().drawing2DStatus, 'idle',
        'removing the last model must take the spinner down without waiting for the abandoned cut');

      cutter.release();
      await settle();
      assert.equal(useViewerStore.getState().drawing2DStatus, 'idle', 'the abandoned cut must not publish a status later');
      assert.equal(useViewerStore.getState().drawing2D, null);
    } finally { cutter.restore(); }
  });

  it('returns the first cut to idle when the panel closes mid-cut', async () => {
    const cutter = holdCutter();
    try {
      const started = cutter.nextStart();
      await render({ geometryResult: geometry(), panelVisible: true });
      await act(async () => { await started; });
      await render({ panelVisible: false });
      assert.equal(useViewerStore.getState().drawing2DStatus, 'idle');
      cutter.release();
      await settle();
      assert.equal(useViewerStore.getState().drawing2DStatus, 'idle');
      assert.equal(useViewerStore.getState().drawing2D, null);
    } finally { cutter.restore(); }
  });

  it('restores ready, not idle, when a cut over an existing drawing is cancelled', async () => {
    await render({ geometryResult: geometry(), panelVisible: true });
    await settle();
    const first = useViewerStore.getState().drawing2D;
    assert.ok(first, 'the unheld first cut published');
    const cutter = holdCutter();
    try {
      const started = cutter.nextStart();
      await render({ geometryResult: geometry(300) });
      await act(async () => { await started; });
      assert.equal(useViewerStore.getState().drawing2DStatus, 'generating');
      await render({ panelVisible: false });
      assert.equal(useViewerStore.getState().drawing2DStatus, 'ready', 'the kept drawing is still the one on screen');
      cutter.release();
      await settle();
      assert.equal(useViewerStore.getState().drawing2D, first, 'the cancelled cut must not replace it');
      assert.equal(useViewerStore.getState().drawing2DStatus, 'ready');
    } finally { cutter.restore(); }
  });

  it('a superseding input keeps the overlay up until the newest cut publishes, with no idle flash', async () => {
    const cutter = holdCutter();
    try {
      const started = cutter.nextStart();
      await render({ geometryResult: geometry(), panelVisible: true });
      await act(async () => { await started; });
      await render({ geometryResult: geometry(400) });
      cutter.release();
      await settle();
      assert.equal(cutter.calls, 2, 'the superseding geometry produced its own cut');
      const ids = new Set(useViewerStore.getState().drawing2D?.cutPolygons.map((p) => p.entityId));
      assert.deepEqual(ids, new Set([400, 401]));
      assert.ok(!statuses.includes('idle'), `no idle between generating and ready: ${statuses.join(' -> ')}`);
      assert.equal(statuses.at(-1), 'ready');
    } finally { cutter.restore(); }
  });
});

describe('BCF capture pending flag ends with its generation (D4, #4802)', () => {
  it('a canvas mounted after a cancelled cut is capturable', async () => {
    await render({ geometryResult: geometry(), panelVisible: true });
    await settle();
    const kept = useViewerStore.getState().drawing2D;
    assert.ok(kept);
    const cutter = holdCutter();
    try {
      const started = cutter.nextStart();
      await render({ sectionPlane: { axis: 'down', position: 40, flipped: false } });
      await act(async () => { await started; });
      await render({ panelVisible: false });
      cutter.release();
      await settle();
    } finally { cutter.restore(); }
    mountCanvasFor(kept);
    assert.equal(hasActiveDrawingCanvas(), true, 'no generation owns the canvas any more');
  });

  it('a canvas mounted after a failed cut is capturable', async () => {
    await render({ geometryResult: geometry(), panelVisible: true });
    await settle();
    const kept = useViewerStore.getState().drawing2D;
    assert.ok(kept);
    const original = Drawing2DGenerator.prototype.generate;
    Drawing2DGenerator.prototype.generate = async () => { throw new Error('cutter failed'); };
    try {
      await render({ sectionPlane: { axis: 'down', position: 40, flipped: false } });
      await settle();
    } finally { Drawing2DGenerator.prototype.generate = original; }
    assert.equal(useViewerStore.getState().drawing2DError, 'cutter failed');
    mountCanvasFor(kept);
    assert.equal(hasActiveDrawingCanvas(), true, 'the failed generation released the pending flag');
  });
});
