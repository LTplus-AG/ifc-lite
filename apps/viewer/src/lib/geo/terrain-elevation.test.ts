/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveTerrainElevationDetailed,
  resolveTerrainElevation,
  clearTerrainElevationCache,
} from './terrain-elevation.js';

/**
 * `terrain-elevation.ts` had no test file at all.
 *
 * Measured before writing this: inverting `isPlausibleElevation` — so that
 * implausible readings are accepted and plausible ones rejected — left the
 * whole `lib/geo` suite at 415/415 passing. That guard is the only thing
 * standing between depth-buffer garbage and a model's placement on the
 * ground, and its "reject and fall through" branch was never taken by
 * anything.
 *
 * The failure it prevents is silent in both directions: accept a `-50000`
 * and the model is buried; reject a legitimate reading and the cascade falls
 * through to a coarser source, or to none, and nothing throws either way.
 *
 * No Cesium and no network here. `Cesium` is used for exactly one call
 * (`Cartographic.fromDegrees`), whose result the module only passes back into
 * these same stubs, and the Open-Meteo path goes through the global `fetch`,
 * stubbed the way `location-map-geocode.test.ts` does it.
 */

type HeightFn = (position: unknown) => number | undefined;

interface SceneStub {
  sampleHeightSupported: boolean;
  sampleHeight: HeightFn;
  sampleHeightMostDetailed: (positions: unknown[]) => Promise<Array<{ height?: number }>>;
  globe: { getHeight: HeightFn };
}

/** Every source declines by default; each test opts one or more back in. */
function makeViewer(overrides: Partial<SceneStub> = {}) {
  const scene: SceneStub = {
    sampleHeightSupported: true,
    sampleHeight: () => undefined,
    sampleHeightMostDetailed: async () => [{}],
    globe: { getHeight: () => undefined },
    ...overrides,
  };
  return { viewer: { scene } as unknown as Parameters<typeof resolveTerrainElevationDetailed>[1], scene };
}

/** `Cartographic.fromDegrees` is the only Cesium call the module makes. */
const CESIUM = {
  Cartographic: { fromDegrees: (lon: number, lat: number) => ({ lon, lat }) },
} as unknown as Parameters<typeof resolveTerrainElevationDetailed>[0];

const realFetch = globalThis.fetch;

/** Open-Meteo replies with `{ elevation: [n] }`; `null` makes it decline. */
function stubOpenMeteo(elevation: number | null): void {
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => (elevation === null ? {} : { elevation: [elevation] }),
    }) as unknown as Response) as typeof fetch;
}

/** Distinct per test so a cache hit can never leak between them. */
let nsCounter = 0;
const freshNs = (): string => `test-ns-${++nsCounter}`;

beforeEach(() => {
  clearTerrainElevationCache();
  stubOpenMeteo(null);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearTerrainElevationCache();
});

describe('terrain elevation source cascade', () => {
  it('falls past an implausible reading to the next source', async () => {
    // THE case the mutation exposed. -50000 is below the Mariana Trench and is
    // the depth-buffer garbage the guard exists to reject. If the guard were
    // inverted or removed, this returns -50000 from scene.sampleHeight and the
    // model is placed 50km underground with no error anywhere.
    const { viewer } = makeViewer({
      sampleHeight: () => -50_000,
      sampleHeightMostDetailed: async () => [{ height: 142.5 }],
    });
    const out = await resolveTerrainElevationDetailed(CESIUM, viewer, 47.3, 8.5, {
      cacheNamespace: freshNs(),
    });
    assert.equal(out?.height, 142.5);
    assert.equal(out?.source, 'scene.sampleHeightMostDetailed');
  });

  it('returns null when every source is implausible', async () => {
    // Without the guard this would return the first garbage value instead.
    const { viewer } = makeViewer({
      sampleHeight: () => -50_000,
      sampleHeightMostDetailed: async () => [{ height: 1e9 }],
      globe: { getHeight: () => Number.NaN },
    });
    stubOpenMeteo(null);
    const out = await resolveTerrainElevationDetailed(CESIUM, viewer, 47.3, 8.5, {
      cacheNamespace: freshNs(),
    });
    assert.equal(out, null);
  });

  it('keeps going when a source throws rather than abandoning the cascade', async () => {
    const { viewer } = makeViewer({
      sampleHeight: () => {
        throw new Error('scene not ready');
      },
      sampleHeightMostDetailed: async () => [{ height: 88 }],
    });
    const out = await resolveTerrainElevationDetailed(CESIUM, viewer, 47.3, 8.5, {
      cacheNamespace: freshNs(),
    });
    assert.equal(out?.height, 88);
  });

  it('skips the scene sources entirely when sampling is unsupported', async () => {
    const { viewer } = makeViewer({
      sampleHeightSupported: false,
      // Both would return a plausible value if they were ever consulted, so a
      // guard that stopped checking `sampleHeightSupported` would show up here
      // as the wrong `source` rather than a wrong height.
      sampleHeight: () => 10,
      sampleHeightMostDetailed: async () => [{ height: 20 }],
      globe: { getHeight: () => 30 },
    });
    const out = await resolveTerrainElevationDetailed(CESIUM, viewer, 47.3, 8.5, {
      cacheNamespace: freshNs(),
    });
    assert.equal(out?.source, 'globe.getHeight');
    assert.equal(out?.height, 30);
  });
});

describe('the plausible-elevation band', () => {
  // ELEV_MIN/-MAX are -1000 and 9000, compared with STRICT inequalities, so
  // the bounds themselves are rejected. Those literals are written out here
  // rather than imported — the constants are module-private, and deriving the
  // fixture from the code under test would make this assert nothing.
  const at = async (h: number) => {
    const { viewer } = makeViewer({ sampleHeight: () => h });
    return resolveTerrainElevationDetailed(CESIUM, viewer, 47.3, 8.5, {
      cacheNamespace: freshNs(),
    });
  };

  it('accepts values strictly inside the band', async () => {
    assert.equal((await at(-999.999))?.height, -999.999);
    assert.equal((await at(8999.999))?.height, 8999.999);
    assert.equal((await at(0.5))?.height, 0.5);
  });

  it('rejects the bounds themselves', async () => {
    // The comparison is `h > MIN && h < MAX`. A silent change to `>=`/`<=`
    // would admit the exact sentinel values, and nothing else notices.
    assert.equal(await at(-1000), null);
    assert.equal(await at(9000), null);
  });

  it('rejects values outside the band', async () => {
    assert.equal(await at(-1000.001), null);
    assert.equal(await at(9000.001), null);
  });

  it('rejects non-finite readings', async () => {
    // `Number.isFinite` is deliberate and not redundant: it is what keeps NaN
    // out, since every comparison against NaN is false but a future widening
    // of the band would otherwise start admitting Infinity.
    assert.equal(await at(Number.NaN), null);
    assert.equal(await at(Number.POSITIVE_INFINITY), null);
    assert.equal(await at(Number.NEGATIVE_INFINITY), null);
  });
});

describe('globe.getHeight near-zero handling', () => {
  it('treats a near-zero height as "no data" and falls through', async () => {
    // `Math.abs(h) <= 1e-3` — Cesium returns 0 for "no terrain loaded here"
    // rather than signalling absence, so the reading is discarded.
    //
    // This is NOT distinguishable from a genuine sea-level reading, and there
    // is no second signal in the API that could separate them. A site at
    // actual elevation 0 therefore falls through to Open-Meteo. That is a
    // permanent property of the design, not a gap this test papers over; it
    // is pinned here so the trade-off is visible if anyone changes the band.
    const { viewer } = makeViewer({ globe: { getHeight: () => 0 } });
    stubOpenMeteo(7.25);
    const out = await resolveTerrainElevationDetailed(CESIUM, viewer, 47.3, 8.5, {
      cacheNamespace: freshNs(),
    });
    assert.equal(out?.source, 'open-meteo');
    assert.equal(out?.height, 7.25);
  });

  it('rejects a height exactly at the near-zero bound', async () => {
    // The comparison is `Math.abs(h) <= 1e-3`, so the bound itself is
    // discarded. Probing at 0.002 alone would leave a 2x margin and say
    // nothing about which way the boundary falls.
    for (const h of [1e-3, -1e-3]) {
      const { viewer } = makeViewer({ globe: { getHeight: () => h } });
      const out = await resolveTerrainElevationDetailed(CESIUM, viewer, 47.3, 8.5, {
        cacheNamespace: freshNs(),
      });
      assert.equal(out, null, `${h} sits on the bound and must be discarded`);
    }
  });

  it('accepts a height just outside the near-zero band', async () => {
    const { viewer } = makeViewer({ globe: { getHeight: () => 0.0011 } });
    const out = await resolveTerrainElevationDetailed(CESIUM, viewer, 47.3, 8.5, {
      cacheNamespace: freshNs(),
    });
    assert.equal(out?.source, 'globe.getHeight');
    assert.equal(out?.height, 0.0011);
  });
});

describe('caching and options', () => {
  it('serves a repeat lookup from cache without re-consulting the source', async () => {
    let calls = 0;
    const { viewer } = makeViewer({
      sampleHeight: () => {
        calls++;
        return 300;
      },
    });
    const ns = freshNs();
    const first = await resolveTerrainElevationDetailed(CESIUM, viewer, 47.3, 8.5, {
      cacheNamespace: ns,
    });
    const second = await resolveTerrainElevationDetailed(CESIUM, viewer, 47.3, 8.5, {
      cacheNamespace: ns,
    });
    assert.equal(calls, 1, 'the second lookup must not re-sample');
    assert.equal(first?.fromCache, false);
    assert.equal(second?.fromCache, true);
    assert.equal(second?.height, 300);
  });

  it('keeps separate namespaces apart', async () => {
    // Namespaces exist so switching terrain provider cannot serve the previous
    // provider's answer. Same coordinates, different namespace, different
    // source value.
    const { viewer } = makeViewer({ sampleHeight: () => 111 });
    const a = await resolveTerrainElevationDetailed(CESIUM, viewer, 47.3, 8.5, {
      cacheNamespace: 'provider-a',
    });
    const { viewer: viewer2 } = makeViewer({ sampleHeight: () => 222 });
    const b = await resolveTerrainElevationDetailed(CESIUM, viewer2, 47.3, 8.5, {
      cacheNamespace: 'provider-b',
    });
    assert.equal(a?.height, 111);
    assert.equal(b?.height, 222);
    assert.equal(b?.fromCache, false);
  });

  it('preferOrthometric consults Open-Meteo before the scene sources', async () => {
    // The reorder puts the orthometric source first. Without it, sampleHeight
    // answers and open-meteo is never reached — so a broken reorder shows up
    // as the wrong `source`, not a wrong height.
    const { viewer } = makeViewer({ sampleHeight: () => 500 });
    stubOpenMeteo(412.5);
    const out = await resolveTerrainElevationDetailed(CESIUM, viewer, 47.3, 8.5, {
      cacheNamespace: freshNs(),
      preferOrthometric: true,
    });
    assert.equal(out?.source, 'open-meteo');
    assert.equal(out?.height, 412.5);
    assert.equal(out?.reference, 'orthometric');
  });

  it('clearTerrainElevationCache actually clears', async () => {
    let calls = 0;
    const { viewer } = makeViewer({
      sampleHeight: () => {
        calls++;
        return 50;
      },
    });
    const ns = freshNs();
    await resolveTerrainElevationDetailed(CESIUM, viewer, 47.3, 8.5, { cacheNamespace: ns });
    clearTerrainElevationCache();
    await resolveTerrainElevationDetailed(CESIUM, viewer, 47.3, 8.5, { cacheNamespace: ns });
    assert.equal(calls, 2, 'a cleared cache must re-sample');
  });

  it('resolveTerrainElevation returns the bare height, and null for no source', async () => {
    const { viewer } = makeViewer({ sampleHeight: () => 640 });
    assert.equal(
      await resolveTerrainElevation(CESIUM, viewer, 47.3, 8.5, { cacheNamespace: freshNs() }),
      640,
    );
    const { viewer: empty } = makeViewer();
    assert.equal(
      await resolveTerrainElevation(CESIUM, empty, 47.3, 8.5, { cacheNamespace: freshNs() }),
      null,
    );
  });
});
