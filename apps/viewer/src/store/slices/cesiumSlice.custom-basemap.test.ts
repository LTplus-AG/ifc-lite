/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Persistence contract for the custom XYZ basemap (issue #2685).
 *
 * The decision the tests pin: the basemap is stored **per browser** in
 * localStorage, next to the ion token and the data-source choice — it does not
 * travel with a project. See `STORAGE_KEY_CUSTOM_BASEMAP`'s comment for why.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import type { CustomBasemap } from '@/lib/geo/custom-basemap';

interface MutableStorage {
  store: Record<string, string>;
}

const DATA_SOURCE_KEY = 'ifc-lite:cesium-data-source';
const BASEMAP_KEY = 'ifc-lite:cesium-custom-basemap';

const BASEMAP: CustomBasemap = {
  protocol: 'xyz',
  url: 'https://tiles.example.org/aerial/{z}/{x}/{y}.png',
  credit: 'Imagery © Example National Mapping Agency, CC BY 4.0',
  creditUrl: 'https://example.org/licence',
  maximumLevel: 20,
};

// The slice reads localStorage inside its state creator, so the shim only has
// to exist before `createCesiumSlice` runs — not before the module import.
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
  cesiumCustomBasemap: CustomBasemap | null;
  setCesiumCustomBasemap: (basemap: CustomBasemap | null) => void;
  setCesiumDataSource: (source: string) => void;
  setCesiumIonToken: (token: string) => void;
  cesiumTerrainHeight: number | null;
  cesiumTerrainSource: string | null;
  cesiumTerrainSaveHeight: number | null;
  cesiumTerrainClipY: number | null;
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

describe('CesiumSlice — custom basemap persistence (issue #2685)', () => {
  let storage: MutableStorage;

  beforeEach(() => { storage = installLocalStorage(); });
  afterEach(() => { uninstallLocalStorage(); });

  it('starts with no custom basemap when nothing is stored', async () => {
    const slice = await buildSlice();
    assert.strictEqual(slice.state.cesiumCustomBasemap, null);
    assert.strictEqual(slice.state.cesiumDataSource, 'google-photorealistic');
  });

  it('round-trips a saved basemap through localStorage into a fresh slice', async () => {
    const first = await buildSlice();
    first.state.setCesiumCustomBasemap(BASEMAP);
    first.state.setCesiumDataSource('custom');

    // A reload = a new slice reading the same storage.
    const reloaded = await buildSlice();
    assert.deepStrictEqual(reloaded.state.cesiumCustomBasemap, BASEMAP);
    assert.strictEqual(reloaded.state.cesiumDataSource, 'custom');
  });

  it('stores it per browser, not in any project payload', async () => {
    const slice = await buildSlice();
    slice.state.setCesiumCustomBasemap(BASEMAP);
    assert.ok(storage.store[BASEMAP_KEY], 'expected the basemap under its localStorage key');
    assert.deepStrictEqual(JSON.parse(storage.store[BASEMAP_KEY]), BASEMAP);
  });

  it('drops a stored "custom" selection when the basemap behind it is gone', async () => {
    storage.store[DATA_SOURCE_KEY] = 'custom';
    const slice = await buildSlice();
    assert.strictEqual(slice.state.cesiumDataSource, 'google-photorealistic');
  });

  it('drops a stored "custom" selection when the stored basemap no longer validates', async () => {
    storage.store[DATA_SOURCE_KEY] = 'custom';
    storage.store[BASEMAP_KEY] = JSON.stringify({ ...BASEMAP, credit: '' });
    const slice = await buildSlice();
    assert.strictEqual(slice.state.cesiumCustomBasemap, null);
    assert.strictEqual(slice.state.cesiumDataSource, 'google-photorealistic');
  });

  it('leaves the custom source when the basemap is cleared, and persists that too', async () => {
    const slice = await buildSlice();
    slice.state.setCesiumCustomBasemap(BASEMAP);
    slice.state.setCesiumDataSource('custom');

    slice.state.setCesiumCustomBasemap(null);
    assert.strictEqual(slice.state.cesiumCustomBasemap, null);
    assert.strictEqual(slice.state.cesiumDataSource, 'google-photorealistic');
    assert.strictEqual(storage.store[BASEMAP_KEY], undefined);
    assert.strictEqual(storage.store[DATA_SOURCE_KEY], 'google-photorealistic');
  });

  /**
   * Leaving `'custom'` because the basemap was removed is a source change like
   * any other, and must tear down what a source change tears down: the terrain
   * elevation cache and the four terrain state fields. Those are keyed to the
   * source that was on screen — a sampled height and a clip plane measured
   * against the custom basemap's terrain mean nothing under the fallback — and
   * `setCesiumDataSource` is the one place that knows the full list.
   *
   * The clearing branch used to write `cesiumDataSource` itself, which is the
   * shape that guarantees the two drift: adding a fifth field to
   * `setCesiumDataSource` would leave this path resetting four. Asserting the
   * fields here is only half the guard — the other half is that there is no
   * second code path left to forget the cache clear, which the delegation makes
   * structural rather than remembered.
   */
  it('clearing the basemap tears terrain down exactly as any other source change does', async () => {
    const slice = await buildSlice();
    slice.state.setCesiumCustomBasemap(BASEMAP);
    slice.state.setCesiumDataSource('custom');
    // Terrain state as it stands after a sample against the custom basemap.
    (slice.state as unknown as { setCesiumTerrainHeight: (h: number | null) => void })
      .setCesiumTerrainHeight(412.5);
    (slice.state as unknown as { setCesiumTerrainSource: (s: string | null) => void })
      .setCesiumTerrainSource('cesium-world-terrain');
    (slice.state as unknown as { setCesiumTerrainSaveHeight: (h: number | null) => void })
      .setCesiumTerrainSaveHeight(412.5);
    (slice.state as unknown as { setCesiumTerrainClipY: (y: number | null) => void })
      .setCesiumTerrainClipY(-3);

    slice.state.setCesiumCustomBasemap(null);

    const s = slice.state as unknown as Record<string, unknown>;
    assert.strictEqual(s.cesiumDataSource, 'google-photorealistic');
    assert.strictEqual(s.cesiumTerrainHeight, null,
      'a height sampled under the removed basemap must not survive the fallback');
    assert.strictEqual(s.cesiumTerrainSource, null);
    assert.strictEqual(s.cesiumTerrainSaveHeight, null);
    assert.strictEqual(s.cesiumTerrainClipY, null);
  });

  it('does not disturb the selection when clearing while another source is active', async () => {
    const slice = await buildSlice();
    slice.state.setCesiumCustomBasemap(BASEMAP);
    slice.state.setCesiumDataSource('osm-map');
    slice.state.setCesiumCustomBasemap(null);
    assert.strictEqual(slice.state.cesiumDataSource, 'osm-map');
  });

  it('survives storage being unavailable rather than throwing on load', async () => {
    uninstallLocalStorage();
    const slice = await buildSlice();
    assert.strictEqual(slice.state.cesiumCustomBasemap, null);
    installLocalStorage();
  });

  // `createCesiumSlice` runs on EVERY store creation, whatever the selected
  // data source, and the slice is spread into `useViewerStore` at module scope.
  // A throw out of `loadCustomBasemap` therefore kills the app at boot: white
  // screen, and the Remove button lives in UI that can no longer mount. So a
  // corrupted key must degrade to "no custom basemap", never to an exception.
  describe('a corrupted storage key must not brick the boot path', () => {
    const CORRUPT: [string, string][] = [
      ['url as a number', '{"protocol":"xyz","url":123,"credit":"c"}'],
      ['url as an array', '{"protocol":"xyz","url":[],"credit":"c"}'],
      ['url as an object', '{"protocol":"xyz","url":{},"credit":"c"}'],
      ['url as a boolean', '{"protocol":"xyz","url":true,"credit":"c"}'],
      ['credit as a number', JSON.stringify({ ...BASEMAP, credit: 5 })],
      ['creditUrl as a number', JSON.stringify({ ...BASEMAP, creditUrl: 5 })],
      ['protocol as a number', JSON.stringify({ ...BASEMAP, protocol: 7 })],
      ['maximumLevel as a string', JSON.stringify({ ...BASEMAP, maximumLevel: '20' })],
      ['an empty object', '{}'],
      ['a bare null', 'null'],
      ['a bare number', '42'],
      ['truncated JSON', '{"protocol":"xyz","url":'],
    ];

    for (const [label, raw] of CORRUPT) {
      it(`${label} — boots with no custom basemap`, async () => {
        storage.store[BASEMAP_KEY] = raw;
        const slice = await buildSlice();
        assert.strictEqual(slice.state.cesiumCustomBasemap, null);
      });

      it(`${label} — and does not strand the picker on the custom source`, async () => {
        storage.store[DATA_SOURCE_KEY] = 'custom';
        storage.store[BASEMAP_KEY] = raw;
        const slice = await buildSlice();
        assert.strictEqual(slice.state.cesiumCustomBasemap, null);
        assert.strictEqual(slice.state.cesiumDataSource, 'google-photorealistic');
      });
    }
  });
});

/**
 * github.com/LTplus-AG/ifc-lite/issues/2765: dropping the four
 * `cesiumTerrain*: null` resets from `setCesiumIonToken` left 33 tests green.
 *
 * The structural twin, `setCesiumDataSource`, has this reset pinned (it was a
 * review finding on #2698) and the token setter did not. Every terrain value
 * is resolved THROUGH the ion token, so keeping them across a token change
 * leaves heights sampled from the previous account's terrain displayed as if
 * they belonged to the new one.
 *
 * Not covered here: the `clearTerrainElevationCache()` call in the same
 * action. The cache is a module-level Map with no read accessor, so a test
 * cannot observe it without adding a production seam for the test's benefit.
 * Named rather than implied, so nobody reads the block below as covering it.
 */
describe('CesiumSlice - changing the ion token invalidates resolved terrain', () => {
  beforeEach(() => { installLocalStorage(); });
  afterEach(() => { uninstallLocalStorage(); });

  it('clears every terrain value resolved under the previous token', async () => {
    const slice = await buildSlice();
    Object.assign(slice.state, {
      cesiumTerrainHeight: 412.5,
      cesiumTerrainSource: 'cesium-world-terrain',
      cesiumTerrainSaveHeight: 410,
      cesiumTerrainClipY: -3.25,
    });

    slice.state.setCesiumIonToken('a-different-account-token');

    assert.deepStrictEqual(
      {
        height: slice.state.cesiumTerrainHeight,
        source: slice.state.cesiumTerrainSource,
        saveHeight: slice.state.cesiumTerrainSaveHeight,
        clipY: slice.state.cesiumTerrainClipY,
      },
      { height: null, source: null, saveHeight: null, clipY: null },
    );
  });

  it('still applies the new token', async () => {
    // The bounding control: an action that only nulled the terrain fields and
    // never stored the token would satisfy the assertion above.
    const slice = await buildSlice();
    slice.state.setCesiumIonToken('a-different-account-token');
    assert.strictEqual(slice.state.cesiumIonToken, 'a-different-account-token');
  });
});
