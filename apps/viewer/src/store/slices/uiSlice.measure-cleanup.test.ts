/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PR #2641 review follow-up: `setActiveTool` never cleared
 * `activePolyline`/`activeMeasurement`, so switching away from the Measure
 * tool mid-sequence and back left a stale click sequence that the next click
 * silently extended (`MeasureOverlay` is mounted purely off
 * `activeTool === 'measure'` — see `ToolOverlays.tsx` — so leaving the tool
 * is the ONLY event that has to clear this).
 *
 * These tests exercise `setActiveTool` directly (no DOM / MeasureOverlay
 * needed) against a mock combined store, mirroring the harness in
 * `uiSlice.edit-mode.test.ts`.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

function installGlobals(): void {
  const store: Record<string, string> = {};
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = String(v);
      },
      removeItem: (k: string) => {
        delete store[k];
      },
      clear: () => {
        for (const k of Object.keys(store)) delete store[k];
      },
      key: (i: number) => Object.keys(store)[i] ?? null,
      get length() {
        return Object.keys(store).length;
      },
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: globalThis,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'matchMedia', {
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'document', {
    value: {
      documentElement: {
        classList: {
          toggle: () => {},
          add: () => {},
          remove: () => {},
          contains: () => false,
        },
      },
    },
    configurable: true,
    writable: true,
  });
}

function uninstallGlobals(): void {
  Reflect.deleteProperty(globalThis as Record<string, unknown>, 'localStorage');
  Reflect.deleteProperty(globalThis as Record<string, unknown>, 'window');
  Reflect.deleteProperty(globalThis as Record<string, unknown>, 'matchMedia');
  Reflect.deleteProperty(globalThis as Record<string, unknown>, 'document');
}

interface SliceHandle {
  readonly state: Record<string, unknown>;
}

/**
 * Build a fresh UISlice on top of a mock combined state that also carries
 * the measurement-slice fields `setActiveTool` reaches into cross-slice
 * (`activePolyline`, `activeMeasurement`, `measureMode`, `resetMeasureGesture`)
 * — a real `useViewerStore` would supply these via `measurementSlice.ts`;
 * here they're seeded directly, same trick `cesiumPlacementEditMode` etc.
 * use in `uiSlice.edit-mode.test.ts`.
 */
async function buildSlice(overrides: Record<string, unknown> = {}): Promise<SliceHandle> {
  const mod = await import('./uiSlice.js');
  const createUISlice = (mod as { createUISlice: (...args: unknown[]) => unknown }).createUISlice;
  let state: Record<string, unknown> = {
    models: new Map(),
    geometryResult: null,
    cesiumPlacementEditMode: false,
    cesiumPlacementDraftModelId: null,
    cesiumPlacementDraft: null,
    // Measurement cross-slice seeds (real shape lives in measurementSlice.ts).
    activePolyline: null,
    activeMeasurement: null,
    measureMode: 'drag',
    resetMeasureGestureCalls: 0,
    resetMeasureGesture: () => {
      state = {
        ...state,
        activePolyline: null,
        activeMeasurement: null,
        resetMeasureGestureCalls: (state.resetMeasureGestureCalls as number) + 1,
      };
    },
  };
  const setState = (partial: unknown) => {
    if (typeof partial === 'function') {
      const updates = (partial as (s: Record<string, unknown>) => Record<string, unknown>)(state);
      state = { ...state, ...updates };
    } else {
      state = { ...state, ...(partial as Record<string, unknown>) };
    }
  };
  const getState = () => state;
  state = {
    ...state,
    ...(createUISlice as (set: unknown, get: unknown, api: unknown) => Record<string, unknown>)(setState, getState, {}),
    ...overrides,
  };
  return {
    get state() {
      return state;
    },
  };
}

describe('UISlice — setActiveTool clears in-progress measure gesture', () => {
  beforeEach(() => installGlobals());
  afterEach(() => uninstallGlobals());

  it('leaving the measure tool with a 2-point polyline in progress clears it', async () => {
    const slice = await buildSlice({
      activeTool: 'measure',
      measureMode: 'polyline',
      activePolyline: { points: [{ x: 0, y: 0, z: 0, screenX: 0, screenY: 0 }, { x: 1, y: 0, z: 0, screenX: 10, screenY: 0 }] },
    });
    (slice.state.setActiveTool as (t: string) => void)('select');
    assert.strictEqual(slice.state.activeTool, 'select');
    assert.strictEqual(slice.state.activePolyline, null, 'stale polyline sequence must not survive a tool switch');
  });

  it('switching back to measure after leaving does not resurrect a stale sequence', async () => {
    const slice = await buildSlice({
      activeTool: 'measure',
      measureMode: 'polyline',
      activePolyline: { points: [{ x: 0, y: 0, z: 0, screenX: 0, screenY: 0 }, { x: 1, y: 0, z: 0, screenX: 10, screenY: 0 }] },
    });
    (slice.state.setActiveTool as (t: string) => void)('select');
    (slice.state.setActiveTool as (t: string) => void)('measure');
    assert.strictEqual(slice.state.activePolyline, null);
  });

  it('leaving the measure tool with an in-progress drag clears activeMeasurement too', async () => {
    const slice = await buildSlice({
      activeTool: 'measure',
      measureMode: 'drag',
      activeMeasurement: { start: { x: 0, y: 0, z: 0, screenX: 0, screenY: 0 }, current: { x: 1, y: 0, z: 0, screenX: 10, screenY: 0 }, distance: 1 },
    });
    (slice.state.setActiveTool as (t: string) => void)('select');
    assert.strictEqual(slice.state.activeMeasurement, null);
  });

  it('does not touch measure gesture state when staying on a non-measure tool', async () => {
    const slice = await buildSlice({ activeTool: 'select', activePolyline: null });
    (slice.state.setActiveTool as (t: string) => void)('section');
    assert.strictEqual(slice.state.resetMeasureGestureCalls, 0);
  });

  it('does not clear anything when re-selecting the measure tool while already on it', async () => {
    const slice = await buildSlice({
      activeTool: 'measure',
      activePolyline: { points: [{ x: 0, y: 0, z: 0, screenX: 0, screenY: 0 }] },
    });
    (slice.state.setActiveTool as (t: string) => void)('measure');
    assert.strictEqual(slice.state.resetMeasureGestureCalls, 0);
    assert.notStrictEqual(slice.state.activePolyline, null);
  });

  it('switching to an authoring tool from measure also clears the gesture', async () => {
    const slice = await buildSlice({
      activeTool: 'measure',
      activePolyline: { points: [{ x: 0, y: 0, z: 0, screenX: 0, screenY: 0 }, { x: 1, y: 0, z: 0, screenX: 10, screenY: 0 }] },
    });
    (slice.state.setActiveTool as (t: string) => void)('addElement');
    assert.strictEqual(slice.state.activeTool, 'addElement');
    assert.strictEqual(slice.state.activePolyline, null);
  });
});
