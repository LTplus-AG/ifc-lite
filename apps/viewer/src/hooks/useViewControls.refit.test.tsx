/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5392: the 2D Section panel kept a stale, cropped view after the drawing
 * regenerated. With Pin on (the default) `fitToView` ran only on first open
 * and on an axis/flip change, so cutting along a picked face (FZK roof,
 * "Custom 2.97 m") reused the plan view's transform and showed a cropped
 * corner, and a panel resize slid the drawing toward a corner.
 *
 * Invariants driven through the real hook:
 *  - a new plane (a face pick) is fitted even when pinned;
 *  - a pinned regeneration that lands entirely outside the view is fitted;
 *  - a pinned regeneration still in view keeps the user's framing;
 *  - a panel resize keeps the user's framing centred once they have framed it;
 *  - (#8802 R3b) the first fit fills the canvas up to a small margin, and a
 *    panel resize before the user frames the view refits.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import type { CachedSheetTransform } from '@/lib/drawing/sheet-geometry-key.js';
import { drawingFitMargin, useViewControls } from './useViewControls.js';

type Transform = { x: number; y: number; scale: number };
type Plane = Parameters<typeof useViewControls>[0]['sectionPlane'];

// A manually driven ResizeObserver: happy-dom never delivers entries.
const observers: Array<() => void> = [];
(globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
  #cb: () => void;
  constructor(cb: () => void) { this.#cb = cb; }
  observe() { observers.push(this.#cb); this.#cb(); }
  unobserve() {}
  disconnect() { const i = observers.indexOf(this.#cb); if (i >= 0) observers.splice(i, 1); }
};

/** The panel's canvas container, with a size the test controls. */
const size = { width: 400, height: 300 };
const containerEl = document.createElement('div');
containerEl.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: size.width, bottom: size.height, width: size.width, height: size.height, toJSON: () => ({}) }) as DOMRect;
document.body.appendChild(containerEl);

function drawing(minX: number, minY: number, maxX: number, maxY: number): Drawing2D {
  return { bounds: { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } } } as unknown as Drawing2D;
}

/** What `fitToView` produces for a plan ('down') drawing: the fit margin per side, centred. */
function fitOf(d: Drawing2D): Transform {
  const { min, max } = d.bounds;
  const m = drawingFitMargin(size);
  const scale = Math.min((size.width - 2 * m) / (max.x - min.x), (size.height - 2 * m) / (max.y - min.y));
  return { scale, x: size.width / 2 - ((min.x + max.x) / 2) * scale, y: size.height / 2 - ((min.y + max.y) / 2) * scale };
}

const PLAN: Plane = { axis: 'down', position: 50, flipped: false };
const ROOF: Plane = { ...PLAN, custom: { normal: [0, 0.866, 0.5], pickedAt: [1, 5, 2] } };

let latest: { t: Transform; set: (t: Transform) => void } | null = null;
let latestFit: (() => void) | null = null;
function Harness({ d, plane, refs = null }: { d: Drawing2D; plane: Plane; refs?: Drawing2D['bounds'] | null }): null {
  const containerRef = useRef<HTMLDivElement | null>(containerEl);
  const cacheRef = useRef<CachedSheetTransform | null>(null);
  const { viewTransform, setViewTransform, fitToView } = useViewControls({
    drawing: d, sectionPlane: plane, containerRef, panelVisible: true, status: 'ready',
    sheetEnabled: false, activeSheet: null, isPinned: true, cachedSheetTransformRef: cacheRef, referenceBounds: refs,
  });
  latest = { t: viewTransform, set: setViewTransform };
  latestFit = fitToView;
  return null;
}

let root: Root | null = null;
const host = document.createElement('div');
document.body.appendChild(host);
/** Render, then let the hook's 50 ms deferred fit run. */
async function show(d: Drawing2D, plane: Plane, refs: Drawing2D['bounds'] | null = null): Promise<Transform> {
  await act(async () => {
    root ??= createRoot(host);
    root.render(<Harness d={d} plane={plane} refs={refs} />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 90)); });
  return latest!.t;
}
function close(a: Transform, b: Transform, what: string): void {
  for (const k of ['x', 'y', 'scale'] as const) {
    assert.ok(Math.abs(a[k] - b[k]) < 1e-6, `${what}: ${k} ${a[k]} vs ${b[k]}`);
  }
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  size.width = 400; size.height = 300;
});

describe('useViewControls refits a stale pinned view (#5392)', () => {
  it('fits the first drawing of a new (face-picked) plane even when pinned', async () => {
    const plan = drawing(0, 0, 20, 10);
    close(await show(plan, PLAN), fitOf(plan), 'first open');
    // The roof section overlaps the plan view but is a different frame entirely.
    const roof = drawing(2, 1, 8, 4);
    close(await show(roof, ROOF), fitOf(roof), 'after the roof face pick');
  });

  it('fits a pinned regeneration that lands entirely outside the view', async () => {
    const plan = drawing(0, 0, 20, 10);
    await show(plan, PLAN);
    const moved = drawing(500, 500, 520, 510); // same plane, cut moved far away
    close(await show(moved, PLAN), fitOf(moved), 'off-view regeneration');
  });

  it('keeps the user framing when a pinned regeneration is still in view', async () => {
    const plan = drawing(0, 0, 20, 10);
    await show(plan, PLAN);
    const zoomed: Transform = { x: -100, y: -40, scale: 40 }; // the user zoomed into a detail
    await act(async () => { latest!.set(zoomed); });
    close(await show(drawing(0, 0, 20, 11), PLAN), zoomed, 'pinned in-view regeneration');
  });

  it('keeps the user framing centred when the panel is resized after they zoomed', async () => {
    const plan = drawing(0, 0, 20, 10);
    await show(plan, PLAN);
    const zoomed: Transform = { x: -100, y: -40, scale: 40 }; // the user zoomed into a detail
    await act(async () => { latest!.set(zoomed); });
    size.width = 600; size.height = 360;
    await act(async () => { for (const cb of observers) cb(); });
    close(latest!.t, { ...zoomed, x: zoomed.x + 100, y: zoomed.y + 30 }, 'after a 200x60 px resize');
  });
});

describe('useViewControls fits the docked drawing to its extents (#8802 R3b)', () => {
  it('fits on open: the drawing fills the canvas up to the margin, centred', async () => {
    const plan = drawing(0, 0, 20, 10);
    const t = await show(plan, PLAN);
    const m = drawingFitMargin(size);
    assert.equal(m, 18, '6% of the 300 px short side');
    // 20 x 10 m into 400 x 300 px: width-bound, (400 - 36) / 20 = 18.2 px/m.
    assert.ok(Math.abs(t.scale - 18.2) < 1e-9, `scale ${t.scale}`);
    const left = t.x + 0 * t.scale, right = t.x + 20 * t.scale;
    assert.ok(Math.abs(left - 18) < 1e-9 && Math.abs(right - 382) < 1e-9, `spans ${left}..${right} px`);
    const top = t.y + 0 * t.scale, bottom = t.y + 10 * t.scale;
    assert.ok(Math.abs((top + bottom) / 2 - 150) < 1e-9, 'vertically centred');
  });

  it('refits when the dock is resized before the user has framed the view', async () => {
    const plan = drawing(0, 0, 20, 10);
    const opened = await show(plan, PLAN);
    // A dock that opened short and then grew: the drawing must grow with it.
    size.width = 400; size.height = 140;
    await act(async () => { for (const cb of observers) cb(); });
    const short = latest!.t;
    close(short, fitOf(plan), 'after shrinking to 400x140');
    // Hard numbers, not the helper: the 16 px floor (6% of 140 = 8.4) leaves
    // 108 px for 10 m, so 10.8 px/m.
    assert.ok(Math.abs(short.scale - 10.8) < 1e-9, `400x140 scale ${short.scale}`);
    assert.ok(short.scale < opened.scale, 'a shorter canvas fits at a smaller scale');
    size.width = 1500; size.height = 420;
    await act(async () => { for (const cb of observers) cb(); });
    close(latest!.t, fitOf(plan), 'after growing to 1500x420');
    // 6% of 420 = 25.2 px per side: (420 - 50.4) / 10 m = 36.96 px/m.
    assert.ok(Math.abs(latest!.t.scale - 36.96) < 1e-9, `1500x420 scale ${latest!.t.scale}`);
    assert.ok(latest!.t.scale > opened.scale, 'a larger canvas fits at a larger scale');
  });

  it('an explicit Fit after the user zoomed resumes refitting on resize', async () => {
    const plan = drawing(0, 0, 20, 10);
    await show(plan, PLAN);
    await act(async () => { latest!.set({ x: 5, y: 5, scale: 3 }); });
    await act(async () => { latestFit!(); });
    close(latest!.t, fitOf(plan), 'Fit');
    size.width = 1500; size.height = 1000;
    await act(async () => { for (const cb of observers) cb(); });
    close(latest!.t, fitOf(plan), 'resize after Fit refits');
    // The 48 px cap (6% of 1000 = 60): (1500 - 96) / 20 m = 70.2 px/m.
    assert.ok(Math.abs(latest!.t.scale - 70.2) < 1e-9, `1500x1000 scale ${latest!.t.scale}`);
  });
});

/**
 * #8802: the sample house's plan cut at 1.2 m with projection on, in its real
 * drawing coordinates (metres). Four walls are cut; the slab, roof outline and
 * kitchen are projected around them; the model's "origin" cube lies 2.4 m off
 * a corner and its "geo-reference" marker about 28 m away. Fitting the union
 * of all of it showed the house as a thumbnail in a corner.
 */
function rect(x0: number, y0: number, x1: number, y1: number) {
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}
function outline(entityId: number, x0: number, y0: number, x1: number, y1: number, category = 'projection') {
  const p = rect(x0, y0, x1, y1);
  return p.map((start, i) => ({ line: { start, end: p[(i + 1) % 4] }, category, visibility: 'visible', entityId, ifcType: 'IfcElement', modelIndex: 0 }));
}
function houseWithMarkers(): Drawing2D {
  const walls: Array<[number, number, number, number, number]> = [
    [315, 3, -9, 3.2, -3], [291, 8.4, -9, 8.6, -4.8], [262, 7, -4.8, 7.2, -3], [353, 8.15, -8.8, 8.17, -5],
  ];
  const cutPolygons = walls.map(([entityId, x0, y0, x1, y1]) => ({
    polygon: { outer: rect(x0, y0, x1, y1), holes: [] }, entityId, ifcType: 'IfcWall', modelIndex: 0, isCut: true,
  }));
  const lines = [
    ...walls.flatMap(([id, x0, y0, x1, y1]) => outline(id, x0, y0, x1, y1, 'cut')),
    ...outline(52, 3.2, -8.8, 8.4, -3),        // floor slab
    ...outline(395, 2.7, -9.3, 5.1, -2.7),     // roof outline, left
    ...outline(425, 5.1, -9.3, 8.9, -2.7),     // roof outline, right
    ...outline(176, 7.55, -7.1, 8.15, -5.5),   // kitchen
    ...outline(482, 0, -1, 1, 0),              // "origin" marker cube
    ...outline(501, -29.64, 13.3, -28.02, 14.99), // "geo-reference" marker
  ];
  return {
    cutPolygons, lines, projectionPolygons: [],
    bounds: { min: { x: -29.64, y: -9.3 }, max: { x: 8.9, y: 14.99 } },
  } as unknown as Drawing2D;
}
/** The house: walls, slab, roof outline and kitchen; no markers. */
const HOUSE = drawing(2.7, -9.3, 8.9, -2.7);

describe('useViewControls frames the building, not far-off markers (#8802)', () => {
  it('the first fit frames the house, not the union with its origin and geo-reference markers', async () => {
    size.width = 1600; size.height = 372; // the docked drawing's canvas in the council scene
    const plan = houseWithMarkers();
    const t = await show(plan, PLAN);
    close(t, fitOf(HOUSE), 'first open');
    // 6.6 m of house into 372 - 2 x 22.32 px: about 49.6 px/m, not the union's 13.5 px/m.
    assert.ok(t.scale > 45, `scale ${t.scale} px/m frames the house`);
    // The markers stay in the drawing: nothing is dropped, they are only outside the frame.
    assert.ok(plan.lines.some((l) => l.entityId === 501), 'the geo-reference marker is still drawn');
  });

  it('the Fit button frames the same building after the user zoomed out', async () => {
    size.width = 1600; size.height = 372;
    const plan = houseWithMarkers();
    await show(plan, PLAN);
    await act(async () => { latest!.set({ x: 0, y: 0, scale: 2 }); });
    await act(async () => { latestFit!(); });
    close(latest!.t, fitOf(HOUSE), 'Fit');
  });

  it('frames a visible reference beside the house, as Fit documents', async () => {
    size.width = 1600; size.height = 372;
    // A placed underlay south-west of the house: the frame is the house plus it.
    const reference = { min: { x: -5, y: -12 }, max: { x: -4, y: -11 } };
    close(await show(houseWithMarkers(), PLAN, reference), fitOf(drawing(-5, -12, 8.9, -2.7)), 'with a reference');
  });
});
