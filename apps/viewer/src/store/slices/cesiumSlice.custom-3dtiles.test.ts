/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Persistence contract for the custom 3D Tiles tileset URL (issue #3607).
 *
 * Mirrors `cesiumSlice.custom-basemap.test.ts`: the URL is stored **per
 * browser** in localStorage, next to the ion token, the XYZ basemap and the
 * data-source choice — it does not travel with a project (same reasoning as
 * `STORAGE_KEY_CUSTOM_BASEMAP`, applied to `STORAGE_KEY_CUSTOM_TILESET_URL`).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

interface MutableStorage {
  store: Record<string, string>;
}

const DATA_SOURCE_KEY = 'ifc-lite:cesium-data-source';
const TILESET_URL_KEY = 'ifc-lite:cesium-custom-tileset-url';

const TILESET_URL = 'https://data.example.org/3dtiles/tileset.json';

function installLocalStorage(initial: Record<string, string> = {}): MutableStorage {
  const handle: MutableStorage = { store: { ...initial } };
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => (key in handle.store ? handle.store[key] : null),
      setItem: (key: string, value: string) => { handle.store[key] = String(value); },
      removeItem: (key: string) => { delete handle.store[key]; },
      clear: () => { handle.store = {}; },
      key: (i: number) => Object.keys(handle.store)[i] ?? null,
      get length() { return Object.keys(handle.store).length; },
    },
    configurable: true,
    writable: true,
  });
  return handle;
}

function uninstallLocalStorage(): void {
  Reflect.deleteProperty(globalThis as Record<string, unknown>, 'localStorage');
}

type SliceState = Record<string, unknown> & {
  cesiumDataSource: string;
  cesiumCustomTilesetUrl: string | null;
  setCesiumCustomTilesetUrl: (url: string | null) => void;
  setCesiumDataSource: (source: string) => void;
};

async function buildSlice(): Promise<{ readonly state: SliceState }> {
  const { createCesiumSlice } = await import('./cesiumSlice.js');
  let state: Record<string, unknown> = {};
  const setState = (partial: unknown) => {
    const updates = typeof partial === 'function'
      ? (partial as (s: Record<string, unknown>) => Record<string, unknown>)(state)
      : (partial as Record<string, unknown>);
    state = { ...state, ...updates };
  };
  state = (createCesiumSlice as unknown as (
    set: unknown, get: unknown, api: unknown,
  ) => Record<string, unknown>)(setState, () => state, {});
  return { get state() { return state as SliceState; } };
}

describe('CesiumSlice — custom 3D Tiles URL persistence (issue #3607)', () => {
  let storage: MutableStorage;

  beforeEach(() => { storage = installLocalStorage(); });
  afterEach(() => { uninstallLocalStorage(); });

  it('starts with no custom tileset URL when nothing is stored', async () => {
    const slice = await buildSlice();
    assert.strictEqual(slice.state.cesiumCustomTilesetUrl, null);
    assert.strictEqual(slice.state.cesiumDataSource, 'google-photorealistic');
  });

  it('round-trips a saved URL through localStorage into a fresh slice', async () => {
    const first = await buildSlice();
    first.state.setCesiumCustomTilesetUrl(TILESET_URL);
    first.state.setCesiumDataSource('custom-3dtiles');

    const reloaded = await buildSlice();
    assert.strictEqual(reloaded.state.cesiumCustomTilesetUrl, TILESET_URL);
    assert.strictEqual(reloaded.state.cesiumDataSource, 'custom-3dtiles');
  });

  it('stores it per browser, not in any project payload', async () => {
    const slice = await buildSlice();
    slice.state.setCesiumCustomTilesetUrl(TILESET_URL);
    assert.strictEqual(storage.store[TILESET_URL_KEY], TILESET_URL);
  });

  it('drops a stored "custom-3dtiles" selection when the URL behind it is gone', async () => {
    storage.store[DATA_SOURCE_KEY] = 'custom-3dtiles';
    const slice = await buildSlice();
    assert.strictEqual(slice.state.cesiumDataSource, 'google-photorealistic');
  });

  it('leaves the custom-3dtiles source when the URL is cleared, and persists that too', async () => {
    const slice = await buildSlice();
    slice.state.setCesiumCustomTilesetUrl(TILESET_URL);
    slice.state.setCesiumDataSource('custom-3dtiles');

    slice.state.setCesiumCustomTilesetUrl(null);
    assert.strictEqual(slice.state.cesiumCustomTilesetUrl, null);
    assert.strictEqual(slice.state.cesiumDataSource, 'google-photorealistic');
    assert.strictEqual(storage.store[TILESET_URL_KEY], undefined);
    assert.strictEqual(storage.store[DATA_SOURCE_KEY], 'google-photorealistic');
  });

  it('does not disturb the selection when clearing while another source is active', async () => {
    const slice = await buildSlice();
    slice.state.setCesiumCustomTilesetUrl(TILESET_URL);
    slice.state.setCesiumDataSource('osm-map');
    slice.state.setCesiumCustomTilesetUrl(null);
    assert.strictEqual(slice.state.cesiumDataSource, 'osm-map');
  });

  it('survives storage being unavailable rather than throwing on load', async () => {
    uninstallLocalStorage();
    const slice = await buildSlice();
    assert.strictEqual(slice.state.cesiumCustomTilesetUrl, null);
    installLocalStorage();
  });

  it('the custom-3dtiles and custom (XYZ) URLs are independent', async () => {
    const slice = await buildSlice();
    slice.state.setCesiumCustomTilesetUrl(TILESET_URL);
    slice.state.setCesiumDataSource('custom-3dtiles');
    assert.strictEqual((slice.state as unknown as { cesiumCustomBasemap: unknown }).cesiumCustomBasemap, null);
  });
});
