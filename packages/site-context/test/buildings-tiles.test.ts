/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The buildings layer over two recorded swisstopo leaf tiles (release
 * 20260520), read through `@ifc-lite/tiles3d`'s public swisstopo reader with
 * a fetch that serves the recording. No network.
 */

import { describe, expect, it } from 'vitest';
import { readSwisstopoBuildings } from '@ifc-lite/tiles3d';
import { lv95Transformer, siteRegion } from '../src/buildings-convert.js';
import { buildSiteContext } from '../src/build.js';
import { BUILDING_SET } from '../src/buildings-layer.js';
import { summarizeSiteContext } from '../src/summary.js';
import type { SiteContextFeature } from '../src/types.js';
import { stubGeodata } from './stub-geodata.js';
import { BERN_LEAF_CENTRE, fixtureFetch, GENEVA_LEAF_POINT, wgs84ToLv95 } from './tiles-support.js';

async function bern(extra: { tileCullMarginMetres?: number; radius?: number } = {}) {
  const fetch = fixtureFetch();
  const doc = await buildSiteContext({
    centre: BERN_LEAF_CENTRE,
    radius: extra.radius ?? 40,
    layers: ['buildings'],
    geodata: stubGeodata(),
    // Margin 0: the recording holds only this leaf, its trimmed siblings answer 404.
    buildings: { fetch, tileCullMarginMetres: 'tileCullMarginMetres' in extra ? extra.tileCullMarginMetres : 0 },
  });
  return { doc, layer: doc.layers[0], fetch };
}

/** The same leaf straight from the reader, every feature of the tile. */
async function readBern() {
  const { x, y } = BERN_LEAF_CENTRE;
  const region = siteRegion({ minX: x - 40, minY: y - 40, maxX: x + 40, maxY: y + 40 }, await lv95Transformer());
  return readSwisstopoBuildings({ region, fetch: fixtureFetch(), featureFilter: 'tiles', tileCullMarginMetres: 0 });
}

function set(f: SiteContextFeature): { [k: string]: unknown } {
  return f.attributes[BUILDING_SET] as { [k: string]: unknown };
}

function absolute(f: SiteContextFeature, i: number): [number, number, number] {
  const p = f.mesh!.positions;
  return [f.origin[0] + p[i * 3], f.origin[1] + p[i * 3 + 1], f.origin[2] + p[i * 3 + 2]];
}

describe('buildings over the recorded Bern leaf (EGID and heights present)', () => {
  it('reads the buildings as IfcBuilding features with their attributes, provenance and attribution', async () => {
    const { layer } = await bern();
    expect(layer.complete).toBe(true);
    expect(layer.features.length).toBeGreaterThan(0);
    for (const f of layer.features) {
      expect(f.ifcType).toBe('IfcBuilding');
      const s = set(f);
      expect(s).toMatchObject({ ObjectType: 'Gebaeude Einzelhaus', DatasetRelease: '20260520', SourceTile: expect.stringMatching(/11\/668\/1170\.b3dm$/) });
      expect(s.EGID).toMatch(/^\d+$/);
      expect(typeof s.UUID).toBe('string');
      for (const k of ['TotalHeight', 'RoofMin', 'RoofMax', 'TerrainPoint']) expect(typeof s[k]).toBe('number');
      expect(f.name).toBe(`Gebaeude Einzelhaus (EGID ${s.EGID})`);
      expect(f.provenance).toMatchObject({ release: '20260520', tile: s.SourceTile });
    }
    expect(layer.attribution).toEqual([expect.objectContaining({ datasetId: 'swissbuildings3d', text: '© swisstopo (swissBUILDINGS3D)' })]);
    expect(layer.provenance).toMatchObject({ releases: ['20260520'], requests: 5, kept: layer.features.length, truncated: false });
    expect(layer.provenance!.conversion).toContain('as-defined');
    expect(layer.issues.map((i) => i.code)).not.toContain('buildings-missing-egid');
  });

  it('lands each building at the EPSG:2056 position of its batch-table longitude/latitude, to a centimetre', async () => {
    const { layer } = await bern();
    const res = await readBern();
    const latLon = new Map(res.features.map((f) => [String(f.attributes.EGID), [f.attributes.Longitude as number, f.attributes.Latitude as number]]));
    for (const f of layer.features) {
      // Longitude/Latitude are the centre of the building's lon/lat box; at Bern the grid is aligned
      // with the meridian (convergence ~0), so that maps onto the centre of its EPSG:2056 box.
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < f.mesh!.positions.length / 3; i++) {
        const [x, y] = absolute(f, i);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      const [lon, lat] = latLon.get(String(set(f).EGID))!;
      // h = 0: @ifc-lite/geo's EPSG:2056 shift ignores height (see the README's frame notes).
      const want = wgs84ToLv95(lon, lat, 0);
      expect(Math.abs((minX + maxX) / 2 - want.x)).toBeLessThan(0.01);
      expect(Math.abs((minY + maxY) / 2 - want.y)).toBeLessThan(0.01);
    }
  });

  it('takes heights as stored: every top equals DACH_MAX (LN02) and no height check fires', async () => {
    const { layer } = await bern();
    for (const f of layer.features) {
      let top = -Infinity, bottom = Infinity;
      for (let i = 0; i < f.mesh!.positions.length / 3; i++) {
        top = Math.max(top, absolute(f, i)[2]);
        bottom = Math.min(bottom, absolute(f, i)[2]);
      }
      expect(top).toBeCloseTo(set(f).RoofMax as number, 2);
      expect(bottom).toBeLessThanOrEqual(set(f).TerrainPoint as number);
      expect(f.origin[2]).toBe(Math.round(bottom));
    }
    expect(layer.issues.map((i) => i.code)).not.toContain('buildings-height-check');
  });

  it('splits each building into the roof (red) and wall (beige) triangles the tile assigns, roof first', async () => {
    const { layer } = await bern();
    const res = await readBern();
    const byEgid = new Map(res.features.map((f) => [String(f.attributes.EGID), f]));
    const left = ['buildings-degenerate-triangles', 'buildings-repeated-faces', 'buildings-interior-faces'].map((code) => layer.issues.find((i) => i.code === code)?.count ?? 0);
    // Recorded tiles store each face twice: the copies are what is left out, counted.
    expect(left[1]).toBeGreaterThan(0);
    let total = 0;
    for (const f of layer.features) {
      const src = byEgid.get(String(set(f).EGID))!;
      const red = src.groups.filter((g) => g.baseColorFactor![0] > 0.8 && g.baseColorFactor![1] < 0.3).reduce((n, g) => n + g.count, 0);
      const parts = f.mesh!.parts!;
      expect(parts.map((p) => p.name)).toEqual(['roof', 'wall']);
      expect(parts[0].firstIndex).toBe(0);
      expect(parts[1].firstIndex).toBe(parts[0].indexCount);
      expect(parts[0].indexCount + parts[1].indexCount).toBe(f.mesh!.indices.length);
      expect(parts[0].indexCount).toBeLessThanOrEqual(red);
      total += src.indices.length - f.mesh!.indices.length;
    }
    expect(total).toBe((left[0] + left[1] + left[2]) * 3);
  });

  it('winds every triangle outward with a matching unit flat normal: every roof triangle open to the sky faces up', async () => {
    const { layer } = await bern();
    // The recorded roofs are closed slabs about 0.2 m thick, so a slab underside rightly faces down;
    // what must face up is every roof triangle with nothing of the building above it.
    const covered = (p: Float32Array, t: number): boolean => {
      const o = t * 9;
      const cx = (p[o] + p[o + 3] + p[o + 6]) / 3, cy = (p[o + 1] + p[o + 4] + p[o + 7]) / 3, cz = (p[o + 2] + p[o + 5] + p[o + 8]) / 3;
      for (let q = 0; q < p.length; q += 9) {
        if (q === o) continue;
        const [ax, ay, bx, by, qx, qy] = [p[q], p[q + 1], p[q + 3], p[q + 4], p[q + 6], p[q + 7]];
        const d = (bx - ax) * (qy - ay) - (qx - ax) * (by - ay);
        if (Math.abs(d) < 1e-9) continue;
        const l1 = ((bx - cx) * (qy - cy) - (qx - cx) * (by - cy)) / d, l2 = ((qx - cx) * (ay - cy) - (ax - cx) * (qy - cy)) / d, l3 = 1 - l1 - l2;
        if (l1 >= 0 && l2 >= 0 && l3 >= 0 && l1 * p[q + 2] + l2 * p[q + 5] + l3 * p[q + 8] > cz + 0.01) return true;
      }
      return false;
    };
    let sky = 0;
    for (const f of layer.features) {
      const { positions: p, normals: n, parts } = f.mesh!;
      let volume = 0;
      for (let t = 0; t < p.length / 9; t++) {
        const o = t * 9;
        const u = [p[o + 3] - p[o], p[o + 4] - p[o + 1], p[o + 5] - p[o + 2]];
        const v = [p[o + 6] - p[o], p[o + 7] - p[o + 1], p[o + 8] - p[o + 2]];
        const c = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const len = Math.hypot(c[0], c[1], c[2]);
        expect(Math.hypot(n[o], n[o + 1], n[o + 2])).toBeCloseTo(1, 5);
        if (len > 1e-4) expect((c[0] * n[o] + c[1] * n[o + 1] + c[2] * n[o + 2]) / len).toBeGreaterThan(0.999);
        volume += (p[o] * c[0] + p[o + 1] * c[1] + p[o + 2] * c[2]) / 6;
        if (t * 3 < parts![0].indexCount && Math.abs(n[o + 2]) > 0.2 && !covered(p, t)) {
          sky++;
          expect(n[o + 2]).toBeGreaterThan(0);
        }
      }
      // Outward winding encloses a positive volume.
      expect(volume).toBeGreaterThan(100);
    }
    expect(sky).toBeGreaterThan(50);
  });

  it('marks the subject by EGID and summarises the layer', async () => {
    const fetch = fixtureFetch();
    const first = (await bern()).layer.features[0];
    const egid = String(set(first).EGID);
    const doc = await buildSiteContext({ centre: BERN_LEAF_CENTRE, radius: 40, layers: ['buildings'], geodata: stubGeodata(), subject: { egid }, buildings: { fetch, tileCullMarginMetres: 0 } });
    const marked = doc.layers[0].features.filter((f) => f.subject);
    expect(marked.map((f) => set(f).EGID)).toEqual([egid]);
    expect(doc.layers[0].features[0]).toBe(marked[0]);
    const s = summarizeSiteContext(doc).buildings!;
    expect(s).toMatchObject({ count: doc.layers[0].features.length, withEgid: doc.layers[0].features.length, requests: 5, subject: { egid, match: { method: 'egid', egid } } });
    expect(s.partTriangles.roof).toBeGreaterThan(0);
    expect(s.partTriangles.wall).toBeGreaterThan(0);
  });

  it('reports the trimmed sibling tiles the default 100 m cull margin selects as failed reads: the layer is incomplete', async () => {
    const { layer } = await bern({ tileCullMarginMetres: undefined });
    expect(layer.complete).toBe(false);
    expect(layer.issues).toContainEqual(expect.objectContaining({ code: 'tiles-http-404', severity: 'error', count: 3 }));
    expect(layer.features.length).toBeGreaterThan(0);
  });
});

describe('buildings over the recorded Geneva leaf (no EGID, no height columns)', () => {
  it('keeps the buildings, nulls the absent attributes and counts them as issues', async () => {
    const t = await lv95Transformer();
    const c = t.fromWgs84([GENEVA_LEAF_POINT.lon, GENEVA_LEAF_POINT.lat])!;
    const doc = await buildSiteContext({ centre: { x: c[0], y: c[1] }, radius: 40, layers: ['buildings'], geodata: stubGeodata(), buildings: { fetch: fixtureFetch(), tileCullMarginMetres: 0 } });
    const layer = doc.layers[0];
    const n = layer.features.length;
    expect(n).toBeGreaterThan(0);
    for (const f of layer.features) {
      expect(set(f)).toMatchObject({ EGID: null, RoofMin: null, RoofMax: null, TerrainPoint: null, TotalHeight: null, ObjectType: 'Gebaeude Einzelhaus' });
      expect(set(f).UUID).toMatch(/^[0-9A-F-]{36}$/);
      expect(f.id).toBe(`building:uuid:${set(f).UUID}`);
      expect(f.name).toBe('Gebaeude Einzelhaus');
    }
    expect(layer.issues).toContainEqual(expect.objectContaining({ code: 'buildings-missing-egid', count: n }));
    expect(layer.issues).toContainEqual(expect.objectContaining({ code: 'buildings-missing-heights', count: n }));
    expect(layer.issues).toContainEqual(expect.objectContaining({ code: 'tiles-missing-attributes', severity: 'warning' }));
    expect(summarizeSiteContext(doc).buildings).toMatchObject({ count: n, withEgid: 0, subject: null });
  });
});
