/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ADVERSARIAL probes for PR #1679 (async lat/lon readout for the geo measure).
 *
 * Targets:
 *   reprojectPointToLatLon(), reprojectionInputKey() in reproject.ts
 * Goal: BREAK them. Each test is named CONFIRMED_* (proves a defect) or
 * REFUTED_* (proves a guard holds).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  reprojectPointToLatLon,
  reprojectionInputKey,
} from './reproject.js';
import type { ProjectedCRS } from '@ifc-lite/parser';

const utmCrs: ProjectedCRS = {
  id: 18,
  name: 'EPSG:32760',
  mapUnit: 'METRE',
  mapUnitScale: 1,
};

// ---------------------------------------------------------------------------
// ATTACK 2: KEY COLLISIONS (delimiter injection, empty/undefined, -0)
// ---------------------------------------------------------------------------
describe('ADVERSARIAL: reprojectionInputKey collisions', () => {
  it('delimiter injection cannot collide two different CRS configs', () => {
    // Free-text fields (description, mapProjection) can contain the '|'
    // character; a join('|') key let content shift across field boundaries
    // and collide. The JSON-encoded key must keep such configs distinct.
    const crsA: ProjectedCRS = {
      id: 1, name: 'EPSG:32760', mapUnitScale: 1,
      description: 'c', mapProjection: 'd|e',
    };
    const crsB: ProjectedCRS = {
      id: 1, name: 'EPSG:32760', mapUnitScale: 1,
      description: 'c|d', mapProjection: 'e',
    };
    const keyA = reprojectionInputKey(500000, 5000000, crsA, 1);
    const keyB = reprojectionInputKey(500000, 5000000, crsB, 1);
    assert.notStrictEqual(keyA, keyB,
      'distinct configs must yield distinct keys (JSON-encoded key is injective)');
  });

  it('zone shifted across field boundaries yields distinct keys', async () => {
    // mapZone is read FIRST by resolveProjection. Shifting a valid zone across
    // the mapZone/description boundary changes reprojection resolvability, so
    // the keys MUST differ or the async effect would freeze on a stale value.
    const resolves: ProjectedCRS = {
      id: 1, name: '', mapZone: '60S', description: 'A|B', mapUnitScale: 1,
    };
    const doesNot: ProjectedCRS = {
      id: 1, name: '', mapZone: '60S|A', description: 'B', mapUnitScale: 1,
    };
    const kR = reprojectionInputKey(500000, 5000000, resolves, 1);
    const kD = reprojectionInputKey(500000, 5000000, doesNot, 1);
    assert.notStrictEqual(kR, kD, 'distinct zone/description splits must yield distinct keys');

    // The two genuinely reproject differently: '60S' -> valid UTM,
    // '60S|A' -> not a zone -> null. Distinct keys make the effect refetch.
    const rr = await reprojectPointToLatLon(500000, 5000000, resolves, 1);
    const rd = await reprojectPointToLatLon(500000, 5000000, doesNot, 1);
    assert.ok(rr, "'60S' should resolve to a lat/lon");
    assert.strictEqual(rd, null, "'60S|A' should be unresolvable");
    // Same key yet different truth: a live georef edit between these is invisible
    // to the effect -> stale lat/lon retained.
  });

  it('PROBE_empty_vs_undefined_name: undefined and empty-string name share a key', () => {
    const a = reprojectionInputKey(1, 2, { id: 1, name: undefined } as unknown as ProjectedCRS, 1);
    const b = reprojectionInputKey(1, 2, { id: 1, name: '' } as ProjectedCRS, 1);
    assert.strictEqual(a, b, 'name ?? "" collapses undefined and "" (benign: same resolveProjection path)');
  });

  it('REFUTED_negative_zero: -0 easting and +0 easting produce the same key (join coerces -0 -> "0")', () => {
    const a = reprojectionInputKey(-0, 0, utmCrs, 1);
    const b = reprojectionInputKey(0, 0, utmCrs, 1);
    assert.strictEqual(a, b, 'no -0 vs 0 key drift');
    assert.ok(!a.includes('-0'), 'key must not contain a literal -0 token');
  });

  it('PROBE_quantisation_rounding_boundary: values 0.5mm either side of a bucket edge', () => {
    // metre CRS: eMm = round(E*1000). E=0.0015 -> 2 (round half up), E=0.0025 -> 3 (round half to even? no, JS Math.round is half-up)
    const a = reprojectionInputKey(0.00149, 0, utmCrs, 1); // *1000=1.49 -> 1
    const b = reprojectionInputKey(0.00151, 0, utmCrs, 1); // *1000=1.51 -> 2
    assert.notStrictEqual(a, b, 'a >0.5mm move across a bucket edge changes the key (expected)');
  });
});

// ---------------------------------------------------------------------------
// ATTACK 3: HOSTILE INPUTS to reprojectPointToLatLon (must return null, never throw / never NaN)
// ---------------------------------------------------------------------------
describe('ADVERSARIAL: reprojectPointToLatLon hostile inputs', () => {
  it('REFUTED_NaN_input: NaN easting/northing returns null (not NaN, not throw)', async () => {
    const r = await reprojectPointToLatLon(NaN, NaN, utmCrs, 1);
    assert.strictEqual(r, null);
  });

  it('REFUTED_Infinity_input: +/-Infinity returns null', async () => {
    const rp = await reprojectPointToLatLon(Infinity, Infinity, utmCrs, 1);
    const rn = await reprojectPointToLatLon(-Infinity, -Infinity, utmCrs, 1);
    assert.strictEqual(rp, null);
    assert.strictEqual(rn, null);
  });

  it('REFUTED_wild_out_of_zone: easting/northing light-years outside the zone returns null (not garbage lat/lon)', async () => {
    const r = await reprojectPointToLatLon(1e18, 1e18, utmCrs, 1);
    if (r) {
      assert.ok(Number.isFinite(r.lat) && Number.isFinite(r.lon), 'if non-null, must be finite');
      assert.ok(r.lat >= -90 && r.lat <= 90, 'lat within range');
      assert.ok(r.lon >= -180 && r.lon <= 180, 'lon within range');
    } else {
      assert.strictEqual(r, null);
    }
  });

  it('PROBE_mapUnitScale_zero: mapUnitScale=0 is silently reinterpreted as 1 (no crash)', async () => {
    const zeroScale: ProjectedCRS = { id: 1, name: 'EPSG:32760', mapUnitScale: 0 };
    // With mapUnitScale=0, resolveMapUnitToMetreScale returns 1 -> treated as metres.
    const r = await reprojectPointToLatLon(500000, 5000000, zeroScale, 1);
    // Should behave identically to a metre CRS, not zero-collapse the coordinates.
    const ref = await reprojectPointToLatLon(500000, 5000000, utmCrs, 1);
    assert.deepStrictEqual(r, ref, 'mapUnitScale=0 falls back to 1 (metre) rather than collapsing to origin');
  });

  it('PROBE_negative_mapUnitScale: negative mapUnitScale also falls back to 1', async () => {
    const neg: ProjectedCRS = { id: 1, name: 'EPSG:32760', mapUnitScale: -0.001 };
    const r = await reprojectPointToLatLon(500000, 5000000, neg, 1);
    const ref = await reprojectPointToLatLon(500000, 5000000, utmCrs, 1);
    assert.deepStrictEqual(r, ref, 'negative mapUnitScale falls back to 1, not a mirrored/negative coordinate');
  });

  it('REFUTED_geographic_out_of_range: geographic CRS with lat>90 returns null', async () => {
    const geo: ProjectedCRS = { id: 1, name: 'EPSG:4326' };
    // eastings=lon, northings=lat. Feed an impossible latitude.
    const r = await reprojectPointToLatLon(200, 999, geo, 1);
    assert.strictEqual(r, null, 'lat 999 must be rejected, not rendered as 999.000000');
  });

  it('PROBE_geographic_ignores_mapUnitScale: geographic CRS does NOT scale eastings by mapUnitScale', async () => {
    // A mm-declared geographic CRS: the geographic branch treats eastings as lon
    // degrees verbatim (no *mapScale). If a file mislabels a lon/lat CRS as
    // MILLIMETRE, a valid lon like 5 is used as-is (fine), but this asymmetry
    // vs the projected branch is worth noting.
    const geoMm: ProjectedCRS = { id: 1, name: 'EPSG:4326', mapUnit: 'MILLIMETRE', mapUnitScale: 0.001 };
    const r = await reprojectPointToLatLon(5, 52, geoMm, 1);
    assert.ok(r, 'lon 5 / lat 52 accepted verbatim');
    assert.strictEqual(r!.lon, 5, 'lon not scaled by mapUnitScale in the geographic branch');
    assert.strictEqual(r!.lat, 52);
  });

  it('REFUTED_never_throws_on_garbage_crs_name: bogus EPSG code returns null', async () => {
    const bogus: ProjectedCRS = { id: 1, name: 'EPSG:0' };
    const r = await reprojectPointToLatLon(500000, 5000000, bogus, 1);
    assert.strictEqual(r, null);
  });
});

// ---------------------------------------------------------------------------
// ATTACK 1 (partial, unit-testable slice): out-of-order microtask resolution.
// The React latest-wins guard lives in the hook (cannot mount here), but we can
// at least confirm reprojectPointToLatLon is deterministic and its resolution
// order for interleaved calls is FIFO for a cached CRS (so the hook's cancelled
// flag is the only thing that must guard order).
// ---------------------------------------------------------------------------
describe('ADVERSARIAL: async ordering sanity (hook guard reasoned separately)', () => {
  it('PROBE_interleaved_resolution_order: two overlapping calls both resolve, order observed', async () => {
    const order: string[] = [];
    const p1 = reprojectPointToLatLon(500000, 5000000, utmCrs, 1).then((r) => { order.push('A'); return r; });
    const p2 = reprojectPointToLatLon(600000, 5000000, utmCrs, 1).then((r) => { order.push('B'); return r; });
    const [a, b] = await Promise.all([p1, p2]);
    assert.ok(a && b);
    // Document the observed order; the hook must NOT rely on it (it uses a
    // per-effect `cancelled` flag instead).
    assert.deepStrictEqual(order, ['A', 'B'], 'FIFO for cached CRS in this run (informational)');
  });
});
