/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Terrain meshing against analytic surfaces: heights at nodes, chunk seams,
 * the skirt, missing data and the counts the resolution rule promises.
 */

import { describe, expect, it } from 'vitest';
import { buildSiteContext } from '../src/build.js';
import { autoResolution } from '../src/frame.js';
import type { SiteContextDocument, SiteContextFeature } from '../src/types.js';
import { paraboloid, plane, stubGeodata, type StubOptions } from './stub-geodata.js';

const CENTRE = { x: 2_600_000, y: 1_200_000 };

async function terrain(radius: number, opts: StubOptions = {}, resolution?: number): Promise<{ doc: SiteContextDocument; chunks: SiteContextFeature[]; skirt: SiteContextFeature | undefined }> {
  const doc = await buildSiteContext({ centre: CENTRE, radius, layers: ['terrain'], resolution, geodata: stubGeodata(opts) });
  const layer = doc.layers[0];
  return {
    doc,
    chunks: layer.features.filter((f) => f.attributes.part === 'surface'),
    skirt: layer.features.find((f) => f.attributes.part === 'skirt'),
  };
}

/** Every vertex as an EPSG:2056 point: feature origin + local position, in f64. */
function worldVertices(f: SiteContextFeature): Array<[number, number, number]> {
  const p = f.mesh!.positions;
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < p.length; i += 3) out.push([f.origin[0] + p[i], f.origin[1] + p[i + 1], f.origin[2] + p[i + 2]]);
  return out;
}

function triangles(features: SiteContextFeature[]): number {
  return features.reduce((n, f) => n + f.mesh!.indices.length / 3, 0);
}

describe('auto resolution rule', () => {
  it('is max(0.5, extent/500), rounded up to 1/16 m', () => {
    expect(autoResolution(200)).toBe(0.5);
    expect(autoResolution(500)).toBe(1);
    expect(autoResolution(1000)).toBe(2);
    expect(autoResolution(100)).toBe(0.5);
    expect(autoResolution(600)).toBe(1.25); // 1.2 rounded up to the 1/16 m step
  });

  it('keeps the terrain near 251 001 vertices and 500 000 triangles', async () => {
    const { chunks } = await terrain(250); // 500 m extent → 1 m
    const res = chunks[0].attributes.resolution as number;
    expect(res).toBe(1);
    const nodes = 501;
    expect(triangles(chunks)).toBe(2 * (nodes - 1) ** 2);
    // 4 × 4 chunks of up to 128 cells; shared edge nodes are duplicated per chunk.
    expect(chunks).toHaveLength(16);
    const vertices = chunks.reduce((n, f) => n + f.mesh!.positions.length / 3, 0);
    expect(vertices).toBe((nodes + 3) ** 2);
  });
});

describe('terrain heights', () => {
  it('puts every vertex of a plane on the plane, to sub-millimetre', async () => {
    const { chunks } = await terrain(60);
    for (const f of chunks) for (const [x, y, z] of worldVertices(f)) expect(Math.abs(z - plane(x, y))).toBeLessThan(1e-3);
  });

  it('samples a paraboloid at the nodes, not between them', async () => {
    const { chunks } = await terrain(60, { height: paraboloid });
    let n = 0;
    for (const f of chunks) {
      for (const [x, y, z] of worldVertices(f)) {
        expect(Math.abs(z - paraboloid(x, y))).toBeLessThan(1e-3);
        n++;
      }
    }
    expect(n).toBeGreaterThan(0);
  });

  it('gives a plane its exact normal', async () => {
    const { chunks } = await terrain(30);
    const len = Math.hypot(0.02, -0.01, 1);
    const nrm = chunks[0].mesh!.normals;
    for (let i = 0; i < nrm.length; i += 3) {
      expect(nrm[i]).toBeCloseTo(-0.02 / len, 3);
      expect(nrm[i + 1]).toBeCloseTo(0.01 / len, 3);
      expect(nrm[i + 2]).toBeCloseTo(1 / len, 3);
    }
  });
});

describe('chunk seams', () => {
  it('shares edge vertices bit for bit between neighbouring chunks', async () => {
    const { chunks } = await terrain(100, { height: paraboloid }); // 200 m at 0.5 m: 400 cells, 4 × 4 chunks
    expect(chunks.length).toBe(16);
    const seen = new Map<string, { z: number; n: string; from: string }>();
    let shared = 0;
    for (const f of chunks) {
      const w = worldVertices(f);
      const nrm = f.mesh!.normals;
      w.forEach(([x, y, z], i) => {
        const key = `${x},${y}`;
        const n = `${nrm[3 * i]},${nrm[3 * i + 1]},${nrm[3 * i + 2]}`;
        const prev = seen.get(key);
        if (prev && prev.from !== f.id) {
          shared++;
          expect(z).toBe(prev.z);
          expect(n).toBe(prev.n);
        } else seen.set(key, { z, n, from: f.id });
      });
    }
    // 3 interior seams per axis, 401 nodes each, both directions; corner nodes counted once per extra chunk.
    expect(shared).toBeGreaterThanOrEqual(2 * 3 * 401);
  });

  it('leaves no gap: every grid cell is covered exactly once', async () => {
    const { chunks } = await terrain(100);
    expect(triangles(chunks)).toBe(2 * 400 * 400);
  });
});

describe('skirt', () => {
  it('closes the outer edge with walls down to 5 m below the lowest height, plus a bottom', async () => {
    const { chunks, skirt } = await terrain(50, { height: paraboloid });
    expect(skirt).toBeDefined();
    const cells = 200; // 100 m at 0.5 m
    expect(skirt!.mesh!.indices.length / 3).toBe(2 * 4 * cells + 2);
    let minZ = Infinity;
    for (const f of chunks) for (const [, , z] of worldVertices(f)) minZ = Math.min(minZ, z);
    const bottom = Math.min(...worldVertices(skirt!).map((v) => v[2]));
    expect(bottom).toBeCloseTo(minZ - 5, 3);
    expect(skirt!.attributes.skirtBottom).toBeCloseTo(minZ - 5, 3);
    // Closure: every top edge of the boundary has its wall, so the walls' top
    // vertices visit each boundary node twice (end of one wall, start of the next).
    const tops = new Map<string, number>();
    for (const [x, y, z] of worldVertices(skirt!)) {
      if (z > bottom + 1e-6) tops.set(`${x},${y}`, (tops.get(`${x},${y}`) ?? 0) + 1);
    }
    expect(tops.size).toBe(4 * cells);
    for (const count of tops.values()) expect(count).toBe(2);
  });
});

describe('missing data', () => {
  it('drops cells with a NaN corner, counts them and marks the layer incomplete', async () => {
    // A 10 m × 10 m hole: nodes strictly inside it are NaN.
    const hole = (x: number, y: number) => x > 2_600_010 && x < 2_600_020 && y > 1_200_010 && y < 1_200_020;
    const { doc, chunks } = await terrain(50, { noData: hole });
    const layer = doc.layers[0];
    expect(layer.complete).toBe(false);
    const issue = layer.issues.find((i) => i.code === 'terrain-nodata-cells');
    // 19 × 19 NaN nodes at 0.5 m touch 20 × 20 cells... plus one ring: (19 + 1)^2.
    expect(issue?.count).toBe(20 * 20);
    expect(triangles(chunks)).toBe(2 * (200 * 200 - 400));
    for (const f of chunks) for (const [x, y] of worldVertices(f)) expect(hole(x, y)).toBe(false);
  });

  it('reports missing tiles and never invents heights for them', async () => {
    const { doc } = await terrain(30, { missingTiles: ['2601-1200'] });
    const layer = doc.layers[0];
    expect(layer.complete).toBe(false);
    expect(layer.issues.map((i) => i.code)).toContain('terrain-missing-tiles');
  });
});
