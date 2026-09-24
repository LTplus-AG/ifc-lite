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
 *  - a panel resize keeps the drawing centred.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import type { CachedSheetTransform } from '@/lib/drawing/sheet-geometry-key.js';
import { useViewControls } from './useViewControls.js';

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

/** What `fitToView` produces for a plan ('down') drawing: 15% padding, centred. */
function fitOf(d: Drawing2D): Transform {
  const { min, max } = d.bounds;
  const scale = Math.min((size.width * 0.7) / (max.x - min.x), (size.height * 0.7) / (max.y - min.y));
  return { scale, x: size.width / 2 - ((min.x + max.x) / 2) * scale, y: size.height / 2 - ((min.y + max.y) / 2) * scale };
}

const PLAN: Plane = { axis: 'down', position: 50, flipped: false };
const ROOF: Plane = { ...PLAN, custom: { normal: [0, 0.866, 0.5], pickedAt: [1, 5, 2] } };

let latest: { t: Transform; set: (t: Transform) => void } | null = null;
function Harness({ d, plane }: { d: Drawing2D; plane: Plane }): null {
  const containerRef = useRef<HTMLDivElement | null>(containerEl);
  const cacheRef = useRef<CachedSheetTransform | null>(null);
  const { viewTransform, setViewTransform } = useViewControls({
    drawing: d, sectionPlane: plane, containerRef, panelVisible: true, status: 'ready',
    sheetEnabled: false, activeSheet: null, isPinned: true, cachedSheetTransformRef: cacheRef,
  });
  latest = { t: viewTransform, set: setViewTransform };
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

  it('keeps the drawing centred when the panel is resized', async () => {
    const plan = drawing(0, 0, 20, 10);
    const fitted = await show(plan, PLAN);
    size.width = 600; size.height = 360;
    await act(async () => { for (const cb of observers) cb(); });
    close(latest!.t, { ...fitted, x: fitted.x + 100, y: fitted.y + 30 }, 'after a 200x60 px resize');
  });
});
