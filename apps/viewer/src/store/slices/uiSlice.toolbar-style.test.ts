/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

// Same in-memory localStorage shim strategy as uiSlice.merge-layers.test.ts:
// `constants.ts` reads localStorage at import-time to seed UI_DEFAULTS, and
// the slice's setters write back to it, so the shim must exist before the
// first slice import.
interface MutableStorage {
  store: Record<string, string>;
}

const STYLE_KEY = 'ifc-lite-toolbar-style';
const COLLAPSED_KEY = 'ifc-lite-ribbon-collapsed';

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

async function buildSlice() {
  const mod = await import('./uiSlice.js');
  const createUISlice = (mod as { createUISlice: (...args: unknown[]) => unknown }).createUISlice;
  let state: Record<string, unknown> = {
    models: new Map(),
    geometryResult: null,
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

describe('UISlice — toolbar style (issue #1686)', () => {
  let storage: MutableStorage | null = null;

  beforeEach(() => {
    storage = installLocalStorage();
  });

  afterEach(() => {
    storage = null;
    uninstallLocalStorage();
  });

  it('seeds toolbarStyle and ribbonCollapsed from UI_DEFAULTS', async () => {
    // ESM modules load once per process, so the initial state mirrors
    // whatever `UI_DEFAULTS` carried at first import — asserting the
    // slice against the defaults table proves it never drifts from it.
    const constantsMod = await import('../constants.js');
    const slice = await buildSlice();
    assert.strictEqual(slice.state.toolbarStyle, constantsMod.UI_DEFAULTS.TOOLBAR_STYLE);
    assert.strictEqual(slice.state.ribbonCollapsed, constantsMod.UI_DEFAULTS.RIBBON_COLLAPSED);
  });

  it('setToolbarStyle switches the style and persists it', async () => {
    const slice = await buildSlice();
    (slice.state.setToolbarStyle as (v: string) => void)('ribbon');
    assert.strictEqual(slice.state.toolbarStyle, 'ribbon');
    assert.strictEqual(storage!.store[STYLE_KEY], 'ribbon');

    (slice.state.setToolbarStyle as (v: string) => void)('classic');
    assert.strictEqual(slice.state.toolbarStyle, 'classic');
    assert.strictEqual(storage!.store[STYLE_KEY], 'classic');
  });

  it('setRibbonCollapsed flips and persists the collapsed flag', async () => {
    const slice = await buildSlice();
    (slice.state.setRibbonCollapsed as (v: boolean) => void)(true);
    assert.strictEqual(slice.state.ribbonCollapsed, true);
    assert.strictEqual(storage!.store[COLLAPSED_KEY], 'true');

    (slice.state.setRibbonCollapsed as (v: boolean) => void)(false);
    assert.strictEqual(slice.state.ribbonCollapsed, false);
    assert.strictEqual(storage!.store[COLLAPSED_KEY], 'false');
  });

  it('survives a locked localStorage (Safari private mode)', async () => {
    const slice = await buildSlice();
    // Simulate storage.setItem throwing after construction.
    (globalThis.localStorage as unknown as { setItem: () => void }).setItem = () => {
      throw new Error('QuotaExceededError');
    };
    (slice.state.setToolbarStyle as (v: string) => void)('ribbon');
    assert.strictEqual(slice.state.toolbarStyle, 'ribbon');
    (slice.state.setRibbonCollapsed as (v: boolean) => void)(true);
    assert.strictEqual(slice.state.ribbonCollapsed, true);
  });
});
