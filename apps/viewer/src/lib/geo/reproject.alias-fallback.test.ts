/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { lookupEpsgByCode } from '@ifc-lite/data';
import { reprojectPointToLatLon } from './reproject.js';

it('NAD83 UTM fallback cannot cache projected metadata as its geographic datum (#7063)', async () => {
  // Exercise the real resolver with an incomplete bundled entry, then a real
  // proj4 network definition. This file has a fresh private projection cache.
  const entry = await lookupEpsgByCode('4269');
  assert.ok(entry?.proj4);
  const definition = entry.proj4;
  const originalFetch = globalThis.fetch;
  delete entry.proj4;
  let requests = 0;
  globalThis.fetch = async input => {
    assert.equal(String(input), 'https://epsg.io/4269.proj4');
    requests++;
    return new Response(definition, { status: 200 });
  };
  try {
    const projected = await reprojectPointToLatLon(500000, 4500000, {
      id: 1, name: 'NAD83', mapZone: '18N', description: 'UTM zone 18N', mapProjection: 'UTM zone 18N',
    });
    assert.ok(projected);
    // Independent pyproj 3.8 / PROJ 9.8 always_xy control.
    assert.ok(Math.abs(projected.lon + 75) < 1e-8);
    assert.ok(Math.abs(projected.lat - 40.65085651660554) < 1e-8);
    assert.equal(requests, 1, 'the canonical geographic lookup must reach its network fallback');
    globalThis.fetch = async () => { throw new Error('network unavailable after first resolution'); };
    const geographic = await reprojectPointToLatLon(5, 52, { id: 1, name: 'EPSG:4269' });
    assert.ok(geographic);
    assert.ok(Math.abs(geographic.lon - 5) < 1e-8);
    assert.ok(Math.abs(geographic.lat - 52) < 1e-8);
    assert.equal(requests, 1, 'canonical geographic coordinates reuse the correctly cached definition');
  } finally {
    entry.proj4 = definition;
    globalThis.fetch = originalFetch;
  }
});
