/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2544 — the store side of the pinned `?geomTier=` override: the Visibility
 * menu can only surface and clear the pin if the slice seeds it and the clear
 * action actually reaches localStorage.
 *
 * Same harness as `uiSlice.merge-layers.test.ts`. The globals must be installed
 * BEFORE the first import of the slice, because `UI_DEFAULTS.GEOM_TIER_OVERRIDE`
 * is evaluated at module-import time — hence the dynamic import inside
 * `buildSlice` and no static import of the slice or constants here.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

const STORAGE_KEY = 'ifc-lite-geom-tier';

interface MutableStorage {
  store: Record<string, string>;
}

function installGlobals(initial: Record<string, string> = {}): MutableStorage {
  const handle: MutableStorage = { store: { ...initial } };
  const storage = {
    getItem: (key: string) => (key in handle.store ? handle.store[key] : null),
    setItem: (key: string, value: string) => { handle.store[key] = String(value); },
    removeItem: (key: string) => { delete handle.store[key]; },
    clear: () => { handle.store = {}; },
    key: (i: number) => Object.keys(handle.store)[i] ?? null,
    get length() { return Object.keys(handle.store).length; },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true, writable: true });
  // `window === globalThis` here, so `getGeomTierOverride`'s
  // `window.location.search` read needs a location on globalThis. Without it the
  // read throws, the catch swallows it into "no override", and every assertion
  // below would pass for the wrong reason.
  Object.defineProperty(globalThis, 'location', {
    value: { search: '' }, configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'matchMedia', {
    value: () => ({
      matches: false, media: '', onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'document', {
    value: {
      documentElement: {
        classList: { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false },
      },
    },
    configurable: true,
    writable: true,
  });
  return handle;
}

function uninstallGlobals(): void {
  for (const k of ['localStorage', 'window', 'location', 'matchMedia', 'document']) {
    Reflect.deleteProperty(globalThis as Record<string, unknown>, k);
  }
}

async function buildSlice(
  crossSlice: { models?: Map<string, unknown>; geometryResult?: { meshes: unknown[] } | null } = {},
) {
  const mod = await import('./uiSlice.js');
  const createUISlice = (mod as { createUISlice: (...args: unknown[]) => unknown }).createUISlice;
  let state: Record<string, unknown> = {
    models: crossSlice.models ?? new Map(),
    geometryResult: crossSlice.geometryResult ?? null,
  };
  const setState = (partial: unknown) => {
    state = typeof partial === 'function'
      ? { ...state, ...(partial as (s: Record<string, unknown>) => Record<string, unknown>)(state) }
      : { ...state, ...(partial as Record<string, unknown>) };
  };
  state = {
    ...state,
    ...(createUISlice as (set: unknown, get: unknown, api: unknown) => Record<string, unknown>)(
      setState, () => state, {},
    ),
  };
  return { get state() { return state; } };
}

const clear = (s: { state: Record<string, unknown> }) =>
  (s.state.clearGeomTierOverride as () => void)();

describe('UISlice — pinned tessellation tier (#2544)', () => {
  let storage: MutableStorage | null = null;

  // Seeded with a pin, because that is the state the whole feature exists for:
  // ESM caches the module, so the FIRST import in this process bakes
  // UI_DEFAULTS.GEOM_TIER_OVERRIDE, and every case here needs it present.
  beforeEach(() => { storage = installGlobals({ [STORAGE_KEY]: 'low' }); });
  afterEach(() => { storage = null; uninstallGlobals(); });

  it('seeds geomTierOverride from the persisted pin', async () => {
    const slice = await buildSlice();
    assert.strictEqual(slice.state.geomTierOverride, 'low');
  });

  it('clearGeomTierOverride removes the persisted key AND the store value', async () => {
    const slice = await buildSlice();
    clear(slice);
    assert.strictEqual(slice.state.geomTierOverride, undefined);
    assert.strictEqual(STORAGE_KEY in storage!.store, false, 'the pin must not survive a reload');
  });

  it('arms the reload prompt, labelled as a tier change, when a model is loaded', async () => {
    const slice = await buildSlice({ geometryResult: { meshes: [{}] } });
    clear(slice);
    assert.strictEqual(slice.state.geometryModePendingReload, true);
    // The banner reads this to name the change; without it the prompt would
    // claim the Fast/Exact mode changed, which it did not.
    assert.strictEqual(slice.state.geometryReloadReason, 'tier');
  });

  it('does NOT arm the reload prompt on an empty viewer', async () => {
    const slice = await buildSlice({ models: new Map(), geometryResult: null });
    clear(slice);
    assert.strictEqual(slice.state.geomTierOverride, undefined);
    assert.strictEqual(slice.state.geometryModePendingReload, false);
  });

  it('is a no-op once no pin remains, so it cannot re-arm the banner', async () => {
    const slice = await buildSlice({ geometryResult: { meshes: [{}] } });
    clear(slice);
    (slice.state.clearGeometryModePendingReload as () => void)();
    clear(slice);
    assert.strictEqual(slice.state.geometryModePendingReload, false);
  });

  it('a later mode flip relabels the prompt, so the banner tracks the last change', async () => {
    const slice = await buildSlice({ geometryResult: { meshes: [{}] } });
    clear(slice);
    assert.strictEqual(slice.state.geometryReloadReason, 'tier');
    (slice.state.setGeometryMode as (v: 'fast' | 'exact') => void)('exact');
    assert.strictEqual(slice.state.geometryReloadReason, 'mode');
  });
});
