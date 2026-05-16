/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

/**
 * Stand up minimal browser globals — `uiSlice.ts` reaches into
 * `localStorage` (theme seed), `matchMedia` (theme detection), and
 * `document.documentElement.classList` (theme apply) at construction
 * time. Mirrors the harness in `uiSlice.merge-layers.test.ts`.
 */
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
 * Build a fresh UISlice on top of a mock combined state.
 *
 * The slice's `createUISlice` returns its own initial values (default
 * `activeTool`, `editEnabled: false`, etc.) which sit on top of the
 * cross-slice seeds. To exercise non-default starting conditions,
 * tests pass `overrides` — these are merged in AFTER slice creation
 * so they actually take effect, rather than being overwritten by the
 * slice's own initial values.
 */
async function buildSlice(overrides: Record<string, unknown> = {}): Promise<SliceHandle> {
  const mod = await import('./uiSlice.js');
  const createUISlice = (mod as { createUISlice: (...args: unknown[]) => unknown }).createUISlice;
  let state: Record<string, unknown> = {
    models: new Map(),
    geometryResult: null,
    // Cesium cross-slice seeds — the slice writes through these when
    // exiting edit mode.
    cesiumPlacementEditMode: false,
    cesiumPlacementDraftModelId: null,
    cesiumPlacementDraft: null,
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

describe('UISlice — edit mode', () => {
  beforeEach(() => installGlobals());
  afterEach(() => uninstallGlobals());

  it('starts disabled', async () => {
    const slice = await buildSlice();
    assert.strictEqual(slice.state.editEnabled, false);
  });

  it('toggle flips the flag', async () => {
    const slice = await buildSlice();
    (slice.state.toggleEditEnabled as () => void)();
    assert.strictEqual(slice.state.editEnabled, true);
    (slice.state.toggleEditEnabled as () => void)();
    assert.strictEqual(slice.state.editEnabled, false);
  });

  it('setEditEnabled(true) leaves authoring tools untouched', async () => {
    const slice = await buildSlice({ activeTool: 'measure' });
    (slice.state.setEditEnabled as (v: boolean) => void)(true);
    assert.strictEqual(slice.state.editEnabled, true);
    assert.strictEqual(slice.state.activeTool, 'measure');
  });

  it('setEditEnabled(false) exits the add-element tool', async () => {
    const slice = await buildSlice({ activeTool: 'addElement', editEnabled: true });
    (slice.state.setEditEnabled as (v: boolean) => void)(false);
    assert.strictEqual(slice.state.editEnabled, false);
    assert.strictEqual(slice.state.activeTool, 'select');
  });

  it('setEditEnabled(false) clears cesium placement state', async () => {
    const slice = await buildSlice({
      activeTool: 'cesium-placement',
      editEnabled: true,
      cesiumPlacementEditMode: true,
      cesiumPlacementDraftModelId: 'model-1',
      cesiumPlacementDraft: { eastings: 1, northings: 2, orthogonalHeight: 3, xAxisAbscissa: 1, xAxisOrdinate: 0 },
    });
    (slice.state.setEditEnabled as (v: boolean) => void)(false);
    assert.strictEqual(slice.state.editEnabled, false);
    assert.strictEqual(slice.state.activeTool, 'select');
    assert.strictEqual(slice.state.cesiumPlacementEditMode, false);
    assert.strictEqual(slice.state.cesiumPlacementDraftModelId, null);
    assert.strictEqual(slice.state.cesiumPlacementDraft, null);
  });

  it('setEditEnabled(false) preserves non-edit tools', async () => {
    const slice = await buildSlice({ activeTool: 'section', editEnabled: true });
    (slice.state.setEditEnabled as (v: boolean) => void)(false);
    assert.strictEqual(slice.state.activeTool, 'section');
  });

  it('setActiveTool to addElement auto-enables edit mode', async () => {
    const slice = await buildSlice();
    (slice.state.setActiveTool as (t: string) => void)('addElement');
    assert.strictEqual(slice.state.activeTool, 'addElement');
    assert.strictEqual(slice.state.editEnabled, true);
  });

  it('setActiveTool to cesium-placement auto-enables edit mode', async () => {
    const slice = await buildSlice();
    (slice.state.setActiveTool as (t: string) => void)('cesium-placement');
    assert.strictEqual(slice.state.editEnabled, true);
  });

  it('setActiveTool to a read-only tool does not touch edit mode', async () => {
    const slice = await buildSlice({ editEnabled: false });
    (slice.state.setActiveTool as (t: string) => void)('measure');
    assert.strictEqual(slice.state.editEnabled, false);
  });
});
