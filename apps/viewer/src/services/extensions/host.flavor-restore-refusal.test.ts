/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A flavor part that could not be applied must reach the caller, not just the
 * console. (#3002)
 *
 * `applyClashFlavorConfig` refuses to commit a config it could not persist —
 * correct, and covered in `clashSlice.flavor.test.ts`. But `switchFlavor`
 * answered `void`, so the refusal only ever became a `console.warn` and the
 * dialog toasted an unqualified "Switched to X" over a flavor whose clash
 * config was never applied. These pin the reason crossing that boundary, in
 * both directions: a refused write that changed nothing must NOT be reported.
 */

import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import type { Flavor } from '@ifc-lite/extensions';
import { ExtensionHostService } from './host.js';
import { IdbFlavorStorage } from './idb-flavor-storage.js';
import {
  buildInitialPresets,
  defaultPresets,
  loadSettings,
  saveSettings,
  serializeClashConfig,
  DEFAULT_CLASH_SETTINGS,
  type ClashGlobalSettings,
  type ClashPreset,
} from '@/lib/clash/persistence';

const SETTINGS_KEY = 'ifc-lite-clash-settings';

/** A working storage that can be told to refuse writes to ONE key. */
class MemoryStorage {
  private store = new Map<string, string>();
  failKey: string | null = null;
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (key === this.failKey) throw new DOMException('quota', 'QuotaExceededError');
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  get length(): number {
    return this.store.size;
  }
  key(i: number): string | null {
    return [...this.store.keys()][i] ?? null;
  }
}

/**
 * Storage the browser hands out but refuses to operate: every method throws.
 * This is the #3002 condition — the loader can neither read the value nor move
 * it aside, so both clash keys land in `unwritableKeys` and every later write
 * is refused with `unreadable`.
 */
class BlockedStorage {
  getItem(): string | null {
    throw new DOMException('blocked', 'SecurityError');
  }
  setItem(): void {
    throw new DOMException('blocked', 'SecurityError');
  }
  removeItem(): void {
    throw new DOMException('blocked', 'SecurityError');
  }
}

const g = globalThis as { localStorage?: unknown };

/**
 * Point the persistence module at `storage` and re-run both loaders, which is
 * what the app does on boot: a clean read clears the key's unwritable mark, a
 * failing one sets it. Without this the module-level mark leaks between tests.
 */
function useStorage(storage: unknown): void {
  g.localStorage = storage;
  buildInitialPresets();
  loadSettings();
}

const FLAVOR_SETTINGS: ClashGlobalSettings = {
  mode: 'clearance',
  tolerance: 0.02,
  clearance: 0.5,
  duplicateTolerance: 0.05,
  clusterEpsilon: 3,
  reportTouch: true,
  groupBy: 'rule',
};

function clashFlavor(id: string, presets: ClashPreset[], settings: ClashGlobalSettings): Flavor {
  return {
    schemaVersion: 1,
    id,
    name: id,
    description: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    extensions: [],
    lenses: [],
    savedQueries: [],
    keybindings: [],
    layout: { state: {} },
    settings: { clash: serializeClashConfig(presets, settings) } as unknown as Flavor['settings'],
  };
}

class TestHost extends ExtensionHostService {
  constructor() {
    super({
      sdk: createBimContext({
        transport: {
          send: () => Promise.reject(new Error('SDK transport is not exercised by this test')),
          subscribe: () => () => {},
          close: () => {},
        },
      }),
    });
  }
}

describe('ExtensionHostService.switchFlavor - unapplied parts reach the caller', () => {
  beforeEach(async () => {
    await new IdbFlavorStorage().clear();
    useStorage(new MemoryStorage());
  });

  it('reports the clash config as unapplied when storage is blocked outright', async () => {
    const host = new TestHost();
    await host.flavors.put(clashFlavor('flv.blocked', defaultPresets(), FLAVOR_SETTINGS));

    useStorage(new BlockedStorage());
    const outcome = await host.switchFlavor('flv.blocked');

    const clash = outcome.unapplied.find((u) => u.part === 'clash');
    assert.ok(clash, `expected a clash entry, got ${JSON.stringify(outcome.unapplied)}`);
    assert.match(clash.message, /could not be read|not saved|left untouched/i);

    // ...and the store really did not take the flavor's settings.
    const { useViewerStore } = await import('@/store');
    assert.notEqual(useViewerStore.getState().clashTolerance, FLAVOR_SETTINGS.tolerance);
  });

  it('reports nothing when a refused settings write would have stored what is already stored', async () => {
    const storage = new MemoryStorage();
    useStorage(storage);
    // Put the flavor's exact settings bytes under the key through the real
    // writer, then block that key: the write the apply attempts is refused but
    // would have changed nothing, so the apply must succeed and stay quiet.
    assert.ok(saveSettings(FLAVOR_SETTINGS).ok);
    storage.failKey = SETTINGS_KEY;

    const host = new TestHost();
    await host.flavors.put(clashFlavor('flv.noop', defaultPresets(), FLAVOR_SETTINGS));
    const outcome = await host.switchFlavor('flv.noop');

    assert.deepEqual(
      outcome.unapplied.filter((u) => u.part === 'clash'),
      [],
    );
    const { useViewerStore } = await import('@/store');
    assert.equal(useViewerStore.getState().clashTolerance, FLAVOR_SETTINGS.tolerance);
  });

  it('reports nothing when every write lands', async () => {
    const host = new TestHost();
    await host.flavors.put(clashFlavor('flv.ok', defaultPresets(), DEFAULT_CLASH_SETTINGS));
    const outcome = await host.switchFlavor('flv.ok');
    assert.deepEqual(outcome.unapplied, []);
  });
});
