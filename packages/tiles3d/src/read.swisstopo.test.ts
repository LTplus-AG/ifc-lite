/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Region reads over recorded swisstopo swissBUILDINGS3D fixtures (release
 * 20260520, see fixtures/README.md). No network.
 */

import { describe, expect, it } from 'vitest';
import { BudgetedFetcher, type TilesCache } from './fetcher.js';
import { ecefToGeodetic } from './geodesy.js';
import { readTilesetRegion } from './read.js';
import { readSwisstopoBuildings, swisstopoRelease } from './swisstopo.js';
import { traverseTileset } from './traverse.js';
import { prepareRegion } from './volume.js';
import { SWISS_BASE, SWISS_ROOT, swissFixtureFetch } from '../test/support.js';

const LEAF = `${SWISS_BASE}20260520/11/668/1170.b3dm`;
const NEIGHBOUR = `${SWISS_BASE}20260520/11/669/1170.b3dm`;
// 11/668/1170 spans lon 7.437909-7.440122, lat 46.951074-46.952043; 11/669/1170 starts at lon 7.440122.
const INSIDE_LEAF = { west: 7.4385, east: 7.4399, south: 46.9512, north: 46.9519 };
const EAST_OF_BOUNDARY = { west: 7.4403, east: 7.4410, south: 46.9512, north: 46.9519 };

describe('traversal over the swisstopo fixtures', () => {
  it('follows root -> dated -> tileset29 -> tileset23 and selects only the leaf under the region', async () => {
    const fetch = swissFixtureFetch();
    const t = await traverseTileset(new BudgetedFetcher({ fetch }), SWISS_ROOT, prepareRegion(INSIDE_LEAF));
    expect(t.selected.map((s) => s.url)).toEqual([LEAF]);
    expect(t.selected[0].tilesetChain.map((u) => u.slice(SWISS_BASE.length))).toEqual([
      'tileset.json', '20260520/tileset.json', '20260520/tileset29.json', '20260520/tileset23.json',
    ]);
    expect(t.selected[0].refine).toBe('ADD');
    expect(t.tilesetsLoaded).toBe(4);
    // The Geneva (tileset9) and Zurich (tileset21) subtrees are culled, never requested.
    expect(fetch.urls.some((u) => u.includes('tileset9') || u.includes('tileset21'))).toBe(false);
    expect(t.issues).toEqual([]);
  });

  it('selects the neighbour, not the leaf, just east of the shared boundary', async () => {
    const t = await traverseTileset(new BudgetedFetcher({ fetch: swissFixtureFetch() }), SWISS_ROOT, prepareRegion(EAST_OF_BOUNDARY));
    expect(t.selected.map((s) => s.url)).toEqual([NEIGHBOUR]);
  });

  it('selects both leaves for a region straddling the boundary', async () => {
    const t = await traverseTileset(new BudgetedFetcher({ fetch: swissFixtureFetch() }), SWISS_ROOT, prepareRegion({ ...INSIDE_LEAF, east: 7.4405 }));
    expect(t.selected.map((s) => s.url).sort()).toEqual([LEAF, NEIGHBOUR]);
  });

  it('follows the Geneva chain through a different subtree', async () => {
    const t = await traverseTileset(new BudgetedFetcher({ fetch: swissFixtureFetch() }), SWISS_ROOT, prepareRegion({ west: 6.1435, east: 6.1450, south: 46.1986, north: 46.1992 }));
    expect(t.selected.map((s) => s.url.slice(SWISS_BASE.length))).toEqual(['20260520/11/83/393.b3dm']);
    expect(t.selected[0].tilesetChain.at(-1)).toBe(`${SWISS_BASE}20260520/tileset1.json`);
  });
});

describe('readTilesetRegion over the swisstopo fixtures', () => {
  it('returns decoded buildings with batch table attributes and provenance', async () => {
    const res = await readTilesetRegion({ url: SWISS_ROOT, region: INSIDE_LEAF, fetch: swissFixtureFetch(), featureFilter: 'tiles' });
    expect(res.complete).toBe(true);
    expect(res.truncated).toBe(false);
    expect(res.stats.requests).toBe(5);
    expect(res.tiles).toHaveLength(1);
    expect(res.tiles[0]).toMatchObject({ kind: 'b3dm', batchLength: 4, featureCount: 4, byteLength: 16012 });
    expect(swisstopoRelease(res.tiles[0])).toBe('20260520');
    // Values cross-checked with an independent Python parse of the batch table JSON.
    expect(res.features.map((f) => f.attributes.EGID)).toEqual([1232102, 1232153, 1232155, 1232123]);
    expect(res.features.map((f) => f.attributes.GELAENDEPUNKT)).toEqual([562.1, 557, 560.24, 562.13]);
    expect(res.features[0].attributes.OBJEKTART).toBe('Gebaeude Einzelhaus');
    // The producer wrote a _match_id column shorter than BATCH_LENGTH: reported, not hidden.
    expect(res.issues).toEqual([expect.objectContaining({ severity: 'warning', message: expect.stringContaining('_match_id') })]);
  });

  it('decodes Draco to the vertex and triangle counts the glTF accessors declare', async () => {
    const res = await readTilesetRegion({ url: SWISS_ROOT, region: INSIDE_LEAF, fetch: swissFixtureFetch(), featureFilter: 'tiles' });
    // glTF JSON: primitive 0 has 3648 indices, primitive 1 has 3708 (Draco-compressed, material 0 / 1).
    const triangles = res.features.reduce((s, f) => s + f.indices.length / 3, 0);
    expect(triangles).toBe((3648 + 3708) / 3);
    const byMaterial = new Map<number, number>();
    for (const f of res.features) {
      for (const g of f.groups) byMaterial.set(g.material!, (byMaterial.get(g.material!) ?? 0) + g.count);
      expect(f.groups.map((g) => g.material)).toEqual([0, 1]);
      expect(f.normals).toHaveLength(f.positions.length);
    }
    expect(byMaterial.get(0)).toBe(3648);
    expect(byMaterial.get(1)).toBe(3708);
  });

  it('transforms normals into the same frame as positions', async () => {
    const res = await readTilesetRegion({ url: SWISS_ROOT, region: INSIDE_LEAF, fetch: swissFixtureFetch(), featureFilter: 'tiles' });
    // Flat-shaded buildings: a vertex normal is parallel to its face normal (sign varies: double-sided, mixed winding).
    let aligned = 0, total = 0;
    for (const f of res.features) {
      const p = f.positions, nrm = f.normals!;
      for (let t = 0; t < f.indices.length; t += 3) {
        const [a, b, c] = [f.indices[t] * 3, f.indices[t + 1] * 3, f.indices[t + 2] * 3];
        const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
        const v = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
        const fn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const len = Math.hypot(fn[0], fn[1], fn[2]);
        if (len < 1e-6) continue;
        total++;
        if (Math.abs(fn[0] * nrm[a] + fn[1] * nrm[a + 1] + fn[2] * nrm[a + 2]) / len > 0.95) aligned++;
      }
    }
    expect(aligned / total).toBeGreaterThan(0.95);
  });

  it('lands decoded buildings where the batch table and tile region say (transform chain)', async () => {
    const res = await readTilesetRegion({ url: SWISS_ROOT, region: INSIDE_LEAF, fetch: swissFixtureFetch(), featureFilter: 'tiles' });
    // tileset23.json region of 11/668/1170.
    const [w, s, e, n, h0, h1] = [7.437909, 46.951074, 7.440122, 46.952043, 549.9, 578.0];
    for (const f of res.features) {
      let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity, top = -Infinity;
      for (let i = 0; i < f.positions.length; i += 3) {
        const g = ecefToGeodetic(f.positions[i], f.positions[i + 1], f.positions[i + 2]);
        west = Math.min(west, g.lon);
        east = Math.max(east, g.lon);
        south = Math.min(south, g.lat);
        north = Math.max(north, g.lat);
        top = Math.max(top, g.height);
        expect(g.height).toBeGreaterThanOrEqual(h0 - 0.01);
        expect(g.height).toBeLessThanOrEqual(h1 + 0.01);
      }
      const lon = (west + east) / 2, lat = (south + north) / 2;
      // The tile holds the buildings whose centre lies inside its region...
      expect(lon).toBeGreaterThanOrEqual(w);
      expect(lon).toBeLessThanOrEqual(e);
      expect(lat).toBeGreaterThanOrEqual(s);
      expect(lat).toBeLessThanOrEqual(n);
      // ...and that centre is the batch table's own Longitude/Latitude (to ~1 cm),
      expect(Math.abs(lon - (f.attributes.Longitude as number)) * 76_000).toBeLessThan(0.01);
      expect(Math.abs(lat - (f.attributes.Latitude as number)) * 111_320).toBeLessThan(0.01);
      // and the highest vertex is the building's DACH_MAX.
      expect(top).toBeCloseTo(f.attributes.DACH_MAX as number, 2);
    }
  });

  it('needs the tile-cull margin to find a building that overhangs its tile', async () => {
    // Building EGID 1232153 sits in 11/668/1170 but reaches ~50 m south of the tile's south edge (46.951074).
    const southOfTile = { west: 7.4385, east: 7.4390, south: 46.95065, north: 46.95090 };
    const without = await readTilesetRegion({ url: SWISS_ROOT, region: southOfTile, fetch: swissFixtureFetch() });
    expect(without.features).toEqual([]);
    const withMargin = await readTilesetRegion({ url: SWISS_ROOT, region: southOfTile, fetch: swissFixtureFetch(), tileCullMarginMetres: 100 });
    expect(withMargin.features.map((f) => f.attributes.EGID)).toEqual([1232153]);
  });

  it('filters features by their own footprint, not just their tile', async () => {
    const all = await readTilesetRegion({ url: SWISS_ROOT, region: INSIDE_LEAF, fetch: swissFixtureFetch(), featureFilter: 'tiles' });
    const tiny = { west: 7.43795, east: 7.43800, south: 46.95108, north: 46.95110 };
    const filtered = await readTilesetRegion({ url: SWISS_ROOT, region: tiny, fetch: swissFixtureFetch() });
    expect(filtered.features.length + filtered.stats.featuresOutsideRegion).toBe(all.features.length);
    expect(filtered.stats.featuresOutsideRegion).toBeGreaterThan(0);
  });

  it('reports the tile it could not fetch as an error and stays incomplete', async () => {
    const res = await readTilesetRegion({ url: SWISS_ROOT, region: EAST_OF_BOUNDARY, fetch: swissFixtureFetch() });
    expect(res.complete).toBe(false);
    expect(res.issues).toEqual([{ url: NEIGHBOUR, severity: 'error', message: `HTTP 404 for ${NEIGHBOUR}` }]);
  });
});

describe('budget, cache, abort and timeout', () => {
  it('truncates explicitly when the request budget runs out during traversal', async () => {
    const res = await readTilesetRegion({ url: SWISS_ROOT, region: INSIDE_LEAF, fetch: swissFixtureFetch(), maxRequests: 2 });
    expect(res.truncated).toBe(true);
    expect(res.complete).toBe(false);
    expect(res.truncation).toEqual({ reason: 'requests', pendingUrls: [`${SWISS_BASE}20260520/tileset29.json`] });
    expect(res.stats.requests).toBe(2);
  });

  it('keeps the traversal and lists the content it could not fetch', async () => {
    const res = await readTilesetRegion({ url: SWISS_ROOT, region: INSIDE_LEAF, fetch: swissFixtureFetch(), maxRequests: 4 });
    expect(res.truncation).toEqual({ reason: 'requests', pendingUrls: [LEAF] });
    expect(res.stats.contentsSelected).toBe(1);
    expect(res.features).toEqual([]);
  });

  it('refuses the response that would cross the byte budget and keeps the bytes count within it', async () => {
    const res = await readTilesetRegion({ url: SWISS_ROOT, region: INSIDE_LEAF, fetch: swissFixtureFetch(), maxBytes: 3000 });
    expect(res.truncation?.reason).toBe('bytes');
    expect(res.stats.bytes).toBeGreaterThan(0);
    expect(res.stats.bytes).toBeLessThanOrEqual(3000);
  });

  it('serves tileset JSON and content from the cache without spending budget', async () => {
    const store = new Map<string, Uint8Array>();
    const cache: TilesCache = { get: (u) => store.get(u), set: (u, b) => void store.set(u, b) };
    const first = await readTilesetRegion({ url: SWISS_ROOT, region: INSIDE_LEAF, fetch: swissFixtureFetch(), cache });
    expect(store.size).toBe(5);
    const fetch = swissFixtureFetch();
    const second = await readTilesetRegion({ url: SWISS_ROOT, region: INSIDE_LEAF, fetch, cache, maxRequests: 0 });
    expect(fetch.urls).toEqual([]);
    expect(second.stats).toMatchObject({ requests: 0, cacheHits: 5 });
    expect(second.complete).toBe(true);
    expect(second.features.length).toBe(first.features.length);
  });

  it('rejects with the abort reason when the caller aborts', async () => {
    const ac = new AbortController();
    const base = swissFixtureFetch();
    const fetch = async (url: string, init: { signal?: AbortSignal }) => {
      if (url.endsWith('tileset29.json')) ac.abort(new Error('user cancelled'));
      return base(url, init);
    };
    await expect(readTilesetRegion({ url: SWISS_ROOT, region: INSIDE_LEAF, fetch, signal: ac.signal })).rejects.toThrow('user cancelled');
  });

  it('turns a per-request timeout into an error issue and keeps going', async () => {
    const base = swissFixtureFetch();
    const fetch = (url: string, init: { signal?: AbortSignal }) => {
      if (!url.endsWith('.b3dm')) return base(url, init);
      return new Promise<never>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    };
    const res = await readTilesetRegion({ url: SWISS_ROOT, region: INSIDE_LEAF, fetch, timeoutMs: 20 });
    expect(res.complete).toBe(false);
    expect(res.issues).toEqual([{ url: LEAF, severity: 'error', message: `request timed out after 20 ms: ${LEAF}` }]);
  });

  it('throws when the root tileset itself cannot be loaded', async () => {
    await expect(readTilesetRegion({ url: `${SWISS_BASE}missing.json`, region: INSIDE_LEAF, fetch: swissFixtureFetch() })).rejects.toThrow('HTTP 404');
  });
});

describe('swisstopo preset', () => {
  it('pins a release and labels the result with the attribution', async () => {
    const fetch = swissFixtureFetch();
    const res = await readSwisstopoBuildings({ region: INSIDE_LEAF, fetch, release: '20260520' });
    expect(fetch.urls[0]).toBe(`${SWISS_BASE}20260520/tileset.json`);
    expect(res.attribution).toContain('swisstopo');
    expect(res.features.length).toBeGreaterThan(0);
    expect(res.features.every((f) => typeof f.attributes.EGID === 'number')).toBe(true);
  });

  it('warns per tile that lacks EGID or the height columns (#10404 review, item 10)', async () => {
    const geneva = await readSwisstopoBuildings({ region: { west: 6.1435, east: 6.1450, south: 46.1986, north: 46.1992 }, fetch: swissFixtureFetch(), release: '20260520' });
    const genevaTile = `${SWISS_BASE}20260520/11/83/393.b3dm`;
    expect(geneva.features.length).toBeGreaterThan(0);
    expect(geneva.issues.filter((i) => i.code === 'missing-attributes')).toEqual([
      { url: genevaTile, severity: 'warning', code: 'missing-attributes', message: 'batch table has no EGID, GELAENDEPUNKT, DACH_MIN, DACH_MAX (building id / height columns absent in this tile)' },
    ]);
    const bern = await readSwisstopoBuildings({ region: INSIDE_LEAF, fetch: swissFixtureFetch(), release: '20260520' });
    expect(bern.issues.filter((i) => i.code === 'missing-attributes')).toEqual([]);
  });

  it('validates the release string', async () => {
    await expect(readSwisstopoBuildings({ region: INSIDE_LEAF, fetch: swissFixtureFetch(), release: 'latest' })).rejects.toThrow(RangeError);
  });
});
