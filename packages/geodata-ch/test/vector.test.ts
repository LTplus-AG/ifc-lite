/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import type { BBox, Position } from '../src/contracts.js';
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
});
