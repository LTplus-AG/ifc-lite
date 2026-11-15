/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { DATASETS } from '../src/attribution.js';
import { createSwissGeodata } from '../src/provider.js';
import { json, mockFetch } from './helpers/mock-fetch.js';
import { VECTOR_LAYERS } from '../src/vector.js';

// Easting 2 600 423, northing 1 199 521 (Bern), the right way round and swapped.
const E = 2_600_423;
const N = 1_199_521;
const SWAPPED_BOX = { minX: N, minY: E, maxX: N + 100, maxY: E + 100 };

/** A client on a fetch that fails the test if anything reaches the network. */
function geo() {
  const m = mockFetch(() => json({ results: [] }));
  return { geo: createSwissGeodata({ fetch: m.fetch, sleep: async () => {}, random: () => 0 }), calls: m.calls };
}

describe('every public entry point with coordinates rejects swapped arguments before any request', () => {
  it('parcelsAtPoint', async () => {
    const { geo: g, calls } = geo();
    await expect(g.parcelsAtPoint(N, E)).rejects.toThrow(/look swapped/);
    expect(calls).toHaveLength(0);
    await expect(g.parcelsAtPoint(E, N)).resolves.toEqual([]);
  });

  it('oerebExtractsAtPoint', async () => {
    const { geo: g, calls } = geo();
    await expect(g.oerebExtractsAtPoint(N, E)).rejects.toThrow(/look swapped/);
    expect(calls).toHaveLength(0);
    await expect(g.oerebExtractsAtPoint(E, N)).resolves.toEqual({ extracts: [], unavailable: [] });
  });

  it('features (bbox and polygon)', async () => {
    const { geo: g, calls } = geo();
    await expect(g.features(VECTOR_LAYERS.roads, SWAPPED_BOX)).rejects.toThrow(/swapped/);
    const ring = [[N, E], [N + 100, E], [N + 100, E + 100], [N, E]];
    await expect(g.features(VECTOR_LAYERS.roads, { type: 'Polygon', coordinates: [ring] })).rejects.toThrow(/swapped/);
    await expect(g.features(VECTOR_LAYERS.roads, { type: 'MultiPolygon', coordinates: [[ring]] })).rejects.toThrow(/swapped/);
    expect(calls).toHaveLength(0);
  });

  it('elevationGrid', async () => {
    const { geo: g, calls } = geo();
    await expect(g.elevationGrid(SWAPPED_BOX, { resolution: 10 })).rejects.toThrow(/swapped/);
    expect(calls).toHaveLength(0);
  });

  it('buildingTiles', async () => {
    const { geo: g, calls } = geo();
    await expect(g.buildingTiles(SWAPPED_BOX)).rejects.toThrow(/swapped/);
    expect(calls).toHaveLength(0);
  });
});

describe('attribution wording', () => {
  it('says the SWISSIMAGE text is layer-level and the product page is authoritative, with its URL', () => {
    const r = DATASETS.swissimage.restrictions.join('\n');
    expect(r).toMatch(/layer-level/);
    expect(r).toMatch(/authoritative/);
    expect(r).toContain('https://www.swisstopo.admin.ch/en/orthoimage-swissimage-10');
  });

  it('points to dataset documentation where the swisstopo terms name a different source line', () => {
    for (const id of ['swissalti3d', 'swissbuildings3d', 'swisstlm3d', 'swissimage'] as const) {
      expect(DATASETS[id].restrictions.join('\n')).toMatch(/different source line.*documentation/);
    }
  });
});
