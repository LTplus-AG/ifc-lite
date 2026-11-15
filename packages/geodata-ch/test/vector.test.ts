/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import type { BBox, Position } from '../src/contracts.js';
import { HttpClient, type CachedResponse } from '../src/http.js';
import { geometryIntersectsPolygon } from '../src/lv95.js';
import { VECTOR_LAYERS, featuresInArea } from '../src/vector.js';
import { fixture, json, mockFetch, testClient } from './helpers/mock-fetch.js';

const LAYER = VECTOR_LAYERS.roads;
const ROOT: BBox = { minX: 2_600_000, minY: 1_199_000, maxX: 2_601_000, maxY: 1_200_000 };

/** Deterministic pseudo-random points. */
function points(n: number, seed = 1): Position[] {
  let s = seed;
  const rnd = (): number => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  return Array.from({ length: n }, () => [ROOT.minX + rnd() * 1000, ROOT.minY + rnd() * 1000]);
}

function inRing(p: Position, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * A fake identify endpoint over point features (plus long lines crossing the
 * whole box, which every cell returns). Like the real service it returns at
 * most `limit` features, in a shuffled order.
 */
function identifyServer(pts: Position[], lines = 0) {
  return mockFetch((url) => {
    if (!url.pathname.endsWith('/identify')) return undefined;
    const q = url.searchParams;
    const limit = Number(q.get('limit'));
    let hit: (p: Position) => boolean;
    if (q.get('geometryType') === 'esriGeometryEnvelope') {
      const [a, b, c, d] = (q.get('geometry') ?? '').split(',').map(Number);
      hit = (p) => p[0] >= a && p[0] <= c && p[1] >= b && p[1] <= d;
    } else {
      const ring = JSON.parse(q.get('geometry') ?? '{}').rings[0] as number[][];
      hit = (p) => inRing(p, ring);
    }
    const results = [
      ...Array.from({ length: lines }, (_, i) => ({
        id: 1_000_000 + i,
        featureId: 1_000_000 + i,
        layerBodId: LAYER,
        geometry: { type: 'LineString', coordinates: [[ROOT.minX, ROOT.minY], [ROOT.maxX, ROOT.maxY]] },
        properties: { objektart: 'line' },
      })),
      ...pts
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => hit(p))
        .map(({ p, i }) => ({ id: i, featureId: i, layerBodId: LAYER, geometry: { type: 'Point', coordinates: p }, properties: {} })),
    ].reverse();
    return json({ results: results.slice(0, limit) });
  });
}

describe('featuresInArea', () => {
  it('splits full cells until every feature is found, each exactly once', async () => {
    const pts = points(1500);
    const server = identifyServer(pts, 3);
    const res = await featuresInArea(testClient(server.fetch), LAYER, ROOT);
    expect(res.truncatedCells).toEqual([]);
    expect(res.features).toHaveLength(1503);
    expect(new Set(res.features.map((f) => f.id)).size).toBe(1503);
    expect(res.requests).toBe(server.calls.length);
    expect(res.requests).toBeGreaterThan(1);
    expect(res.attribution[0].datasetId).toBe('swisstlm3d');
  });

  it('issues one request when the area is sparse', async () => {
    const server = identifyServer(points(50));
    const res = await featuresInArea(testClient(server.fetch), LAYER, ROOT);
    expect(res.requests).toBe(1);
    expect(res.features).toHaveLength(50);
  });

  it('reports cells still capped at the depth limit rather than returning silently short', async () => {
    const server = identifyServer(points(3000));
    const res = await featuresInArea(testClient(server.fetch), LAYER, ROOT, { maxDepth: 1 });
    expect(res.truncatedCells.length).toBeGreaterThan(0);
    expect(res.features.length).toBeLessThan(3000);
  });

  it('queries only the polygon: cells outside it cost nothing, points outside are not returned', async () => {
    const pts = points(1500);
    const tri = { type: 'Polygon' as const, coordinates: [[[ROOT.minX, ROOT.minY], [ROOT.maxX, ROOT.minY], [ROOT.minX, ROOT.maxY], [ROOT.minX, ROOT.minY]]] };
    const server = identifyServer(pts);
    const res = await featuresInArea(testClient(server.fetch), LAYER, tri);
    const expected = pts.filter((p) => inRing(p, tri.coordinates[0])).length;
    expect(res.features).toHaveLength(expected);
    expect(res.truncatedCells).toEqual([]);
  });

  it('parses a recorded swissTLM3D roads response', async () => {
    const m = mockFetch((url) => (url.pathname.endsWith('/identify') ? json(fixture('identify-roads-polygon.json')) : undefined));
    const area = { type: 'Polygon' as const, coordinates: [[[2_600_400, 1_199_500], [2_600_600, 1_199_500], [2_600_600, 1_199_800], [2_600_400, 1_199_500]]] };
    const res = await featuresInArea(testClient(m.fetch), LAYER, area);
    expect(res.features).toHaveLength(3);
    expect(res.features[0].geometry?.type).toBe('MultiLineString');
    expect(res.features[0].properties).toHaveProperty('objektart');
    const q = m.calls[0].searchParams;
    expect([q.get('sr'), q.get('tolerance'), q.get('mapExtent')]).toEqual(['2056', '0', null]);
  });

  it('marks a layer whose terms were not recorded instead of attributing nothing', async () => {
    const server = identifyServer([]);
    const res = await featuresInArea(testClient(server.fetch), 'ch.example.unknown', ROOT);
    expect(res.attribution[0]).toMatchObject({ datasetId: 'ch.example.unknown', termsVerifiedOn: null });
  });

  it('returns the partial result with an explicit flag when maxRequests runs out, instead of throwing it away', async () => {
    const server = identifyServer(points(1500));
    const res = await featuresInArea(testClient(server.fetch), LAYER, ROOT, { maxRequests: 3 });
    expect(res.requests).toBe(3);
    expect(res.requestLimitReached).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.unqueriedCells.length).toBeGreaterThan(0);
    expect(res.features.length).toBeGreaterThan(0);
    expect(res.features.length).toBeLessThan(1500);
  });

  it('is not truncated when complete', async () => {
    const res = await featuresInArea(testClient(identifyServer(points(50)).fetch), LAYER, ROOT);
    expect([res.truncated, res.requestLimitReached, res.unqueriedCells, res.bboxFallbackCells]).toEqual([false, false, [], []]);
  });

  it('flags a depth-limited result as truncated too', async () => {
    const res = await featuresInArea(testClient(identifyServer(points(3000)).fetch), LAYER, ROOT, { maxDepth: 1 });
    expect(res.truncated).toBe(true);
    expect(res.requestLimitReached).toBe(false);
  });
});

/** A many-vertex, roughly circular polygon inside ROOT. */
function circle(n: number, cx = 2_600_500, cy = 1_199_500, r = 400): number[][] {
  const ring = Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
  return [...ring, ring[0]];
}

describe('featuresInArea with long polygons and MultiPolygons', () => {
  it('keeps every request URL short: a 600-vertex polygon falls back to the bounding box, clipped client-side', async () => {
    const pts = points(60);
    const ring = circle(600);
    const poly = { type: 'Polygon' as const, coordinates: [ring] };
    const server = identifyServer(pts);
    const res = await featuresInArea(testClient(server.fetch), LAYER, poly);
    expect(res.bboxFallbackCells.length).toBeGreaterThan(0);
    expect(res.requests).toBe(server.calls.length);
    for (const c of server.calls) expect(c.href.length).toBeLessThanOrEqual(6000);
    // Features the bounding-box query returned beside the polygon are dropped again.
    const expected = pts.filter((p) => inRing(p, ring)).length;
    expect(res.features).toHaveLength(expected);
    expect(expected).toBeGreaterThan(0);
    expect(expected).toBeLessThan(60);
  });

  it('sends the exact polygon, and reports no fallback, when the URL is short enough', async () => {
    const server = identifyServer(points(60));
    const tri = { type: 'Polygon' as const, coordinates: [[[2_600_100, 1_199_100], [2_600_900, 1_199_100], [2_600_100, 1_199_900], [2_600_100, 1_199_100]]] };
    const res = await featuresInArea(testClient(server.fetch), LAYER, tri);
    expect(res.bboxFallbackCells).toEqual([]);
    expect(server.calls[0].searchParams.get('geometryType')).toBe('esriGeometryPolygon');
  });

  it('accepts a MultiPolygon: each member is queried, results merged without duplicates', async () => {
    const pts = points(300);
    const a = [[2_600_050, 1_199_050], [2_600_450, 1_199_050], [2_600_450, 1_199_450], [2_600_050, 1_199_450], [2_600_050, 1_199_050]];
    const b = [[2_600_550, 1_199_550], [2_600_950, 1_199_550], [2_600_950, 1_199_950], [2_600_550, 1_199_950], [2_600_550, 1_199_550]];
    const res = await featuresInArea(testClient(identifyServer(pts).fetch), LAYER, { type: 'MultiPolygon', coordinates: [[a], [b]] });
    const expected = pts.filter((p) => inRing(p, a) || inRing(p, b)).length;
    expect(res.features).toHaveLength(expected);
    expect(new Set(res.features.map((f) => f.id)).size).toBe(expected);
    expect(res.requests).toBe(2);
  });

  it('rejects an unsupported area geometry with a clear error', async () => {
    const bad = { type: 'Point', coordinates: [2_600_000, 1_199_000] } as never;
    await expect(featuresInArea(testClient(identifyServer([]).fetch), LAYER, bad)).rejects.toThrow(/unsupported area geometry/);
  });
});

describe('featuresInArea request accounting', () => {
  it('counts queries apart from network sends: a retry is a further send, a cache hit none', async () => {
    const server = identifyServer(points(20));
    let first = true;
    const flaky = async (u: string, i?: RequestInit): Promise<Response> => {
      if (first) {
        first = false;
        return new Response('busy', { status: 503 });
      }
      return server.fetch(u, i);
    };
    const res = await featuresInArea(testClient(flaky), LAYER, ROOT);
    expect(res.requests).toBe(1);
    expect(res.networkRequests).toBe(2);

    const cache = new Map<string, CachedResponse>();
    const cached = new HttpClient({
      fetch: server.fetch,
      sleep: async () => {},
      random: () => 0,
      cache: { get: (k) => cache.get(k), set: (k, v) => void cache.set(k, v) },
    });
    await featuresInArea(cached, LAYER, ROOT);
    const again = await featuresInArea(cached, LAYER, ROOT);
    expect(again.requests).toBe(1);
    expect(again.networkRequests).toBe(0);
  });
});

describe('featuresInArea guards and the bounding-box fallback', () => {
  const longPoly = { type: 'Polygon' as const, coordinates: [circle(600)] };

  it('rejects a NaN or negative budget instead of silently disabling it', async () => {
    const c = testClient(identifyServer(points(3000)).fetch);
    for (const bad of [{ maxRequests: NaN }, { maxDepth: NaN }, { maxUrlLength: NaN }, { maxRequests: -1 }]) {
      await expect(featuresInArea(c, LAYER, ROOT, bad)).rejects.toThrow(/must be a number >= 0/);
    }
  });

  it('keeps a point exactly on the polygon edge when the bounding box was queried', async () => {
    const ring = circle(600);
    const onEdge: Position = [ring[0][0], ring[0][1]]; // a polygon vertex, so on its right-most edge
    const server = mockFetch((url) =>
      url.pathname.endsWith('/identify')
        ? json({ results: [{ id: 1, featureId: 1, layerBodId: LAYER, geometry: { type: 'Point', coordinates: onEdge }, properties: {} }] })
        : undefined,
    );
    const res = await featuresInArea(testClient(server.fetch), LAYER, { type: 'Polygon', coordinates: [ring] });
    expect(res.bboxFallbackCells.length).toBeGreaterThan(0);
    expect(res.features.map((f) => f.id)).toEqual(['1']);
  });

  it('names features without geometry that the fallback could not test', async () => {
    const server = mockFetch((url) =>
      url.pathname.endsWith('/identify')
        ? json({ results: [{ id: 7, featureId: 7, layerBodId: LAYER, properties: {} }] })
        : undefined,
    );
    const res = await featuresInArea(testClient(server.fetch), LAYER, longPoly);
    expect(res.bboxFallbackCells.length).toBeGreaterThan(0);
    expect(res.features.map((f) => f.id)).toEqual(['7']);
    expect(res.unverifiedFeatureIds).toEqual(['7']);
  });

  it('reports no unverified features when the exact polygon was sent', async () => {
    const tri = { type: 'Polygon' as const, coordinates: [[[2_600_100, 1_199_100], [2_600_900, 1_199_100], [2_600_100, 1_199_900], [2_600_100, 1_199_100]]] };
    const res = await featuresInArea(testClient(identifyServer(points(10)).fetch), LAYER, tri);
    expect(res.unverifiedFeatureIds).toEqual([]);
  });
});

describe('geometryIntersectsPolygon', () => {
  it('counts a point on the right edge or a vertex as touching', () => {
    const sq = { type: 'Polygon' as const, coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
    for (const p of [[10, 5], [0, 5], [5, 0], [5, 10], [10, 10]]) {
      expect(geometryIntersectsPolygon({ type: 'Point', coordinates: p }, sq)).toBe(true);
    }
    expect(geometryIntersectsPolygon({ type: 'Point', coordinates: [10.001, 5] }, sq)).toBe(false);
  });

  const sq = { type: 'Polygon' as const, coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
  const holed = { type: 'Polygon' as const, coordinates: [sq.coordinates[0], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] };
  it('handles points, lines crossing without a vertex inside, containment both ways, and holes', () => {
    expect(geometryIntersectsPolygon({ type: 'Point', coordinates: [5, 5] }, sq)).toBe(true);
    expect(geometryIntersectsPolygon({ type: 'Point', coordinates: [15, 5] }, sq)).toBe(false);
    expect(geometryIntersectsPolygon({ type: 'LineString', coordinates: [[-5, 5], [15, 5]] }, sq)).toBe(true);
    expect(geometryIntersectsPolygon({ type: 'LineString', coordinates: [[-5, 11], [15, 11]] }, sq)).toBe(false);
    expect(geometryIntersectsPolygon({ type: 'Polygon', coordinates: [[[-5, -5], [20, -5], [20, 20], [-5, 20], [-5, -5]]] }, sq)).toBe(true);
    expect(geometryIntersectsPolygon({ type: 'Polygon', coordinates: [[[2, 2], [3, 2], [3, 3], [2, 2]]] }, sq)).toBe(true);
    expect(geometryIntersectsPolygon({ type: 'Point', coordinates: [5, 5] }, holed)).toBe(false);
  });
});

