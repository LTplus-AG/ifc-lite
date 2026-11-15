/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import type { BBox } from '../src/contracts.js';
import type { StacItem } from '../src/stac.js';
import { elevationGrid, selectTiles } from '../src/terrain.js';
import { fixture, json, mockFetch, rangeResponse, testClient } from './helpers/mock-fetch.js';
import { writeTiledGeoTiff, type GeoTiffLevel } from './helpers/tiled-geotiff.js';

/** The test terrain: an inclined plane, so bilinear interpolation of pixel-centre samples is exact. */
const plane = (x: number, y: number): number => 500 + 0.01 * (x - 2_600_000) + 0.02 * (y - 1_199_000);

/** A 1 km tile at 62.5 m (16 px) with a 125 m overview (8 px), values = `f` at pixel centres. */
function tile(e: number, n: number, f: (x: number, y: number) => number, holes: Array<[number, number]> = []): ArrayBuffer {
  const level = (px: number): GeoTiffLevel => {
    const size = 1000 / px;
    const values = new Float32Array(size * size);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) values[r * size + c] = f(e + (c + 0.5) * px, n + 1000 - (r + 0.5) * px);
    }
    if (px === 62.5) for (const [c, r] of holes) values[r * size + c] = -9999;
    return { width: size, height: size, values };
  };
  return writeTiledGeoTiff({
    levels: [level(62.5), level(125)],
    tileSize: 16,
    originX: e,
    originY: n + 1000,
    pixelSize: 62.5,
    noData: -9999,
    epsg: 2056,
  });
}

function item(year: number, ekm: number, nkm: number): StacItem {
  const id = `swissalti3d_${year}_${ekm}-${nkm}`;
  return {
    id,
    bbox: [0, 0, 0, 0],
    properties: { datetime: `${year}-01-01T00:00:00Z` },
    assets: {
      [`${id}_2_2056_5728.tif`]: {
        href: `https://cog.test/${id}_2.tif`,
        type: 'image/tiff; application=geotiff; profile=cloud-optimized',
        gsd: 2,
      },
      [`${id}_0.5_2056_5728.tif`]: {
        href: `https://cog.test/${id}_0.5.tif`,
        type: 'image/tiff; application=geotiff; profile=cloud-optimized',
        gsd: 0.5,
      },
    },
  };
}

function terrainServer(cogs: Record<string, ArrayBuffer>, items: StacItem[]) {
  /** The `Range` header of every request that reached a COG (`undefined`: a whole-file read). */
  const cogRanges: Array<string | undefined> = [];
  const server = mockFetch(
    (url) =>
      url.pathname.endsWith('/collections/ch.swisstopo.swissalti3d/items')
        ? json({ type: 'FeatureCollection', features: items, links: [] })
        : undefined,
    (url, init) => {
      const cog = cogs[url.href];
      if (cog) cogRanges.push((init?.headers as Record<string, string> | undefined)?.Range);
      return cog ? rangeResponse(cog, init) : undefined;
    },
  );
  return { ...server, cogRanges };
}

const BOX: BBox = { minX: 2_600_200, minY: 1_199_200, maxX: 2_601_700, maxY: 1_199_800 };

describe('elevationGrid', () => {
  it('mosaics two tiles across their seam and reproduces the plane at every node', async () => {
    const constant = (): number => 9999;
    const server = terrainServer(
      {
        'https://cog.test/swissalti3d_2025_2600-1199_2.tif': tile(2_600_000, 1_199_000, plane),
        'https://cog.test/swissalti3d_2025_2601-1199_2.tif': tile(2_601_000, 1_199_000, plane),
        'https://cog.test/swissalti3d_2019_2600-1199_2.tif': tile(2_600_000, 1_199_000, constant),
      },
      [item(2019, 2600, 1199), item(2025, 2600, 1199), item(2025, 2601, 1199)],
    );
    const grid = await elevationGrid(testClient(server.fetch), BOX, { resolution: 100 });

    expect(grid.crs).toBe('EPSG:2056');
    expect(grid.verticalCrs).toBe('EPSG:5728');
    expect(grid.width).toBe(16);
    expect(grid.height).toBe(7);
    expect(grid.noDataCount).toBe(0);
    expect(grid.missingTiles).toEqual([]);
    for (let row = 0; row < grid.height; row++) {
      for (let col = 0; col < grid.width; col++) {
        const x = grid.origin.x + col * grid.resolution;
        const y = grid.origin.y - row * grid.resolution;
        expect(grid.values[row * grid.width + col]).toBeCloseTo(plane(x, y), 3);
      }
    }
    // Newest acquisition per tile; full-resolution level (62.5 m ≤ 100 m).
    expect(grid.sources.map((s) => s.id).sort()).toEqual(['swissalti3d_2025_2600-1199', 'swissalti3d_2025_2601-1199']);
    expect(grid.sources.every((s) => s.gsd === 62.5)).toBe(true);
    // Range requests only: every request that reached a COG carried a byte range.
    expect(server.cogRanges.length).toBeGreaterThan(0);
    expect(server.cogRanges.every((r) => r !== undefined && /^bytes=\d+-\d+$/.test(r))).toBe(true);
  });

  it('the Range recording sees a whole-file read when one is made', async () => {
    const url = 'https://cog.test/swissalti3d_2025_2600-1199_2.tif';
    const server = terrainServer({ [url]: tile(2_600_000, 1_199_000, plane) }, []);
    await testClient(server.fetch).get(url);
    expect(server.cogRanges).toEqual([undefined]);
  });

  it('reads the internal overview when the requested spacing allows it', async () => {
    const server = terrainServer(
      {
        'https://cog.test/swissalti3d_2025_2600-1199_2.tif': tile(2_600_000, 1_199_000, plane),
        'https://cog.test/swissalti3d_2025_2601-1199_2.tif': tile(2_601_000, 1_199_000, plane),
      },
      [item(2025, 2600, 1199), item(2025, 2601, 1199)],
    );
    const grid = await elevationGrid(testClient(server.fetch), BOX, { resolution: 250 });
    expect(grid.sources.every((s) => s.gsd === 125)).toBe(true);
    expect(grid.values[0]).toBeCloseTo(plane(BOX.minX, BOX.maxY), 3);
  });

  it('pins an acquisition year when asked', async () => {
    const server = terrainServer(
      {
        'https://cog.test/swissalti3d_2025_2600-1199_2.tif': tile(2_600_000, 1_199_000, plane),
        'https://cog.test/swissalti3d_2019_2600-1199_2.tif': tile(2_600_000, 1_199_000, () => 42),
      },
      [item(2019, 2600, 1199), item(2025, 2600, 1199)],
    );
    const box = { minX: 2_600_200, minY: 1_199_200, maxX: 2_600_800, maxY: 1_199_800 };
    const grid = await elevationGrid(testClient(server.fetch), box, { resolution: 100, year: 2019 });
    expect(Array.from(grid.values).every((v) => v === 42)).toBe(true);
  });

  it('reports a missing tile and leaves its cells NaN instead of filling them', async () => {
    const server = terrainServer(
      { 'https://cog.test/swissalti3d_2025_2600-1199_2.tif': tile(2_600_000, 1_199_000, plane) },
      [item(2025, 2600, 1199)],
    );
    // Reaches 300 m into tile 2600-1200, which the catalogue does not have.
    const box = { minX: 2_600_200, minY: 1_199_500, maxX: 2_600_600, maxY: 1_200_300 };
    const grid = await elevationGrid(testClient(server.fetch), box, { resolution: 100 });
    expect(grid.missingTiles).toEqual(['2600-1200']);
    expect(grid.hasData).toBe(true);
    const rowOf = (y: number): number => Math.round((box.maxY - y) / 100);
    for (let col = 0; col < grid.width; col++) {
      // Nodes north of the last pixel centre of 2600-1199 have no support.
      expect(Number.isNaN(grid.values[rowOf(1_200_000) * grid.width + col])).toBe(true);
      expect(grid.values[rowOf(1_199_900) * grid.width + col]).toBeCloseTo(plane(box.minX + col * 100, 1_199_900), 3);
    }
    expect(grid.noDataCount).toBe(4 * grid.width);
  });

  it('gives a box wholly outside coverage as an all-NaN grid with missingTiles and hasData false', async () => {
    const server = terrainServer({}, []);
    const grid = await elevationGrid(testClient(server.fetch), { minX: 2_700_000, minY: 1_100_000, maxX: 2_700_300, maxY: 1_100_300 }, { resolution: 100 });
    expect(grid.missingTiles).toContain('2700-1100');
    expect(grid.noDataCount).toBe(grid.width * grid.height);
    expect(Array.from(grid.values).every(Number.isNaN)).toBe(true);
    expect(grid.hasData).toBe(false);
    expect(grid.sources).toEqual([]);
  });

  it('turns NoData pixels into NaN only where they contribute', async () => {
    // Pixel (col 8, row 8) of tile 2600-1199 covers x 2600500–2600562.5, y 1199437.5–1199500.
    const server = terrainServer(
      { 'https://cog.test/swissalti3d_2025_2600-1199_2.tif': tile(2_600_000, 1_199_000, plane, [[8, 8]]) },
      [item(2025, 2600, 1199)],
    );
    const box = { minX: 2_600_100, minY: 1_199_100, maxX: 2_600_900, maxY: 1_199_900 };
    const grid = await elevationGrid(testClient(server.fetch), box, { resolution: 100 });
    const at = (x: number, y: number): number => grid.values[((box.maxY - y) / 100) * grid.width + (x - box.minX) / 100];
    expect(Number.isNaN(at(2_600_500, 1_199_500))).toBe(true);
    expect(at(2_600_300, 1_199_300)).toBeCloseTo(plane(2_600_300, 1_199_300), 3);
    expect(grid.noDataCount).toBeGreaterThan(0);
    expect(grid.noDataCount).toBeLessThan(4);
  });

  it('rejects boxes that are not LV95 and absurd sizes', async () => {
    const client = testClient(mockFetch().fetch);
    await expect(elevationGrid(client, { minX: 7.4, minY: 46.9, maxX: 7.5, maxY: 47 }, { resolution: 1 })).rejects.toThrow(
      /not in LV95/,
    );
    await expect(elevationGrid(client, BOX, { resolution: 0.01 })).rejects.toThrow(/maxNodes/);
    // NaN compares false with everything: it must be refused, not let the limit lapse.
    await expect(elevationGrid(client, BOX, { resolution: 0.01, maxNodes: NaN })).rejects.toThrow(/maxNodes must be a number/);
    await expect(elevationGrid(client, BOX, { resolution: 100, maxSourcePixels: NaN })).rejects.toThrow(/maxSourcePixels must be a number/);
  });
});

describe('selectTiles on the recorded catalogue', () => {
  it('keeps the newest acquisition of tile 2600-1199', () => {
    const fc = fixture<{ features: StacItem[] }>('stac-swissalti3d-items-2600-1199.json');
    const { tiles, missing } = selectTiles(fc.features, { minX: 2_600_100, minY: 1_199_100, maxX: 2_600_900, maxY: 1_199_900 });
    expect(missing).toEqual([]);
    expect(tiles.map((t) => t.item.id)).toEqual(['swissalti3d_2025_2600-1199']);
  });
});
