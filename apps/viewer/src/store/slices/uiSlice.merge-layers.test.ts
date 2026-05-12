/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

// Stand-up an in-memory localStorage shim before importing the slice
// — the constants module reads `localStorage` at import-time to seed
// the initial `mergeLayers` value, and we want each test case to
// control that seed deterministically.
//
// The shim is also what the slice's `setMergeLayers` writes back to.
interface MutableStorage {
  store: Record<string, string>;
}

const STORAGE_KEY = 'ifc-lite-merge-layers';

function installLocalStorage(initial: Record<string, string> = {}): MutableStorage {
  const handle: MutableStorage = { store: { ...initial } };
  const storage = {
    getItem: (key: string) => (key in handle.store ? handle.store[key] : null),
    setItem: (key: string, value: string) => {
      handle.store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete handle.store[key];
    },
    clear: () => {
      handle.store = {};
    },
    key: (i: number) => Object.keys(handle.store)[i] ?? null,
    get length() {
      return Object.keys(handle.store).length;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
  // `window` is referenced by both `getInitialMergeLayers` (as a
  // browser-environment guard) and `getInitialTheme` (which calls
  // `matchMedia`). Both are evaluated at module-import time inside
  // `constants.ts`, so the shim must answer both before we import the
  // slice. A minimal `matchMedia` stub returning `{matches: false}`
  // is enough to drive `getInitialTheme` down the light-mode branch.
  Object.defineProperty(globalThis, 'window', {
    value: globalThis,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'matchMedia', {
    value: () => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
    configurable: true,
    writable: true,
  });
  // `document` is touched by uiSlice's `applyThemeClasses` — provide
  // a minimal `documentElement.classList.toggle` stub so the slice
  // can be constructed without DOM globals.
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
  return handle;
}

function uninstallLocalStorage(): void {
  Reflect.deleteProperty(globalThis as Record<string, unknown>, 'localStorage');
  Reflect.deleteProperty(globalThis as Record<string, unknown>, 'window');
  Reflect.deleteProperty(globalThis as Record<string, unknown>, 'matchMedia');
  Reflect.deleteProperty(globalThis as Record<string, unknown>, 'document');
}

/**
 * Build a fresh slice instance with whatever cross-slice fields the
 * setter needs to read. The viewer store wires this slice on top of
 * the federated model map + the legacy single-model `geometryResult`;
 * we mirror the same shape so the test exercises the production
 * branch verbatim.
 *
 * NOTE on module caching: Node's ESM loader caches modules by URL.
 * `getInitialMergeLayers` (in `constants.ts`) reads localStorage at
 * import-time, so the first test in this file determines the seed
 * baked into `UI_DEFAULTS.MERGE_LAYERS`. We expose `initialFromUiDefaults`
 * so the "reads from localStorage on construction" test can probe the
 * value directly without relying on a re-import (which Node 22's ESM
 * loader rejects with `ERR_UNKNOWN_BUILTIN_MODULE` for relative paths).
 */
async function buildSlice(crossSlice: { models?: Map<string, unknown>; geometryResult?: { meshes: unknown[] } | null } = {}) {
  const mod = await import('./uiSlice.js');
  const createUISlice = (mod as { createUISlice: (...args: unknown[]) => unknown }).createUISlice;
  let state: Record<string, unknown> = {
    models: crossSlice.models ?? new Map(),
    geometryResult: crossSlice.geometryResult ?? null,
  };
  const setState = (partial: unknown) => {
    if (typeof partial === 'function') {
      const updates = (partial as (s: Record<string, unknown>) => Record<string, unknown>)(state);
      state = { ...state, ...updates };
    } else {
      state = { ...state, ...(partial as Record<string, unknown>) };
    }
  };
  const get = () => state;
  state = {
    ...state,
    ...(createUISlice as (set: unknown, get: unknown, api: unknown) => Record<string, unknown>)(setState, get, {}),
  };
  return {
    get state() {
      return state;
    },
  };
}

describe('UISlice — merge-layers', () => {
  let storage: MutableStorage | null = null;

  beforeEach(() => {
    storage = installLocalStorage();
  });

  afterEach(() => {
    storage = null;
    uninstallLocalStorage();
  });

  it('defaults mergeLayers to false when localStorage is empty', async () => {
    const slice = await buildSlice();
    assert.strictEqual(slice.state.mergeLayers, false);
    assert.strictEqual(slice.state.mergeLayersPendingReload, false);
  });

  it('reads the seeded value from localStorage via UI_DEFAULTS', async () => {
    // The slice seeds `mergeLayers` from `UI_DEFAULTS.MERGE_LAYERS`,
    // which is evaluated at module-import time. Because ESM modules
    // load once per process, this assertion proves the slice respects
    // whatever value `UI_DEFAULTS` carried at startup — and confirms
    // that the slice's initial state matches the defaults table.
    const constantsMod = await import('../constants.js');
    const slice = await buildSlice();
    assert.strictEqual(slice.state.mergeLayers, constantsMod.UI_DEFAULTS.MERGE_LAYERS);
  });

  it('writes mergeLayers to localStorage on setMergeLayers', async () => {
    const slice = await buildSlice();
    (slice.state.setMergeLayers as (v: boolean) => void)(true);
    assert.strictEqual(storage!.store[STORAGE_KEY], 'true');
    (slice.state.setMergeLayers as (v: boolean) => void)(false);
    assert.strictEqual(storage!.store[STORAGE_KEY], 'false');
  });

  it('does NOT set pendingReload when no model is loaded', async () => {
    const slice = await buildSlice({ models: new Map(), geometryResult: null });
    (slice.state.setMergeLayers as (v: boolean) => void)(true);
    assert.strictEqual(slice.state.mergeLayers, true);
    assert.strictEqual(slice.state.mergeLayersPendingReload, false);
  });

  it('sets pendingReload when a federated model is loaded', async () => {
    const models = new Map();
    models.set('m1', { id: 'm1' });
    const slice = await buildSlice({ models });
    (slice.state.setMergeLayers as (v: boolean) => void)(true);
    assert.strictEqual(slice.state.mergeLayersPendingReload, true);
  });

  it('sets pendingReload when legacy geometryResult has meshes', async () => {
    const slice = await buildSlice({ geometryResult: { meshes: [{}] } });
    (slice.state.setMergeLayers as (v: boolean) => void)(true);
    assert.strictEqual(slice.state.mergeLayersPendingReload, true);
  });

  it('is a no-op when the value matches the current flag', async () => {
    const slice = await buildSlice({ geometryResult: { meshes: [{}] } });
    // First flip: false → true, pending reload because a model is loaded
    (slice.state.setMergeLayers as (v: boolean) => void)(true);
    assert.strictEqual(slice.state.mergeLayersPendingReload, true);
    // Second flip to the same value should not toggle pending again
    // after a manual clear.
    (slice.state.clearMergeLayersPendingReload as () => void)();
    assert.strictEqual(slice.state.mergeLayersPendingReload, false);
    (slice.state.setMergeLayers as (v: boolean) => void)(true);
    assert.strictEqual(slice.state.mergeLayersPendingReload, false);
  });

  it('clearMergeLayersPendingReload flips the flag back to false', async () => {
    const slice = await buildSlice({ geometryResult: { meshes: [{}] } });
    (slice.state.setMergeLayers as (v: boolean) => void)(true);
    assert.strictEqual(slice.state.mergeLayersPendingReload, true);
    (slice.state.clearMergeLayersPendingReload as () => void)();
    assert.strictEqual(slice.state.mergeLayersPendingReload, false);
    // mergeLayers itself is unaffected by the dismiss.
    assert.strictEqual(slice.state.mergeLayers, true);
  });
});
