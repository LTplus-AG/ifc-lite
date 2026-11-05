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
function Harness({ d, plane }: { d: Drawing2D; plane: Plane }): null {
  const containerRef = useRef<HTMLDivElement | null>(containerEl);
  const cacheRef = useRef<CachedSheetTransform | null>(null);
  const { viewTransform, setViewTransform, fitToView } = useViewControls({
    drawing: d, sectionPlane: plane, containerRef, panelVisible: true, status: 'ready',
    sheetEnabled: false, activeSheet: null, isPinned: true, cachedSheetTransformRef: cacheRef,
  });
  latest = { t: viewTransform, set: setViewTransform };
  latestFit = fitToView;
  return null;
}

let root: Root | null = null;
const host = document.createElement('div');
document.body.appendChild(host);
/** Render, then let the hook's 50 ms deferred fit run. */
async function show(d: Drawing2D, plane: Plane): Promise<Transform> {
  await act(async () => {
    root ??= createRoot(host);
    root.render(<Harness d={d} plane={plane} />);
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
