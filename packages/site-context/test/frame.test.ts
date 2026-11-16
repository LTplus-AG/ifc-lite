/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The site frame, refusals and the layers the build does not implement. */

import { describe, expect, it } from 'vitest';
import { buildSiteContext } from '../src/build.js';
import { SiteContextCoverageError } from '../src/frame.js';
import { decodeSiteContextGlb, encodeSiteContextGlb, summarizeSiteContext } from '../src/index.js';
import { plane, stubGeodata } from './stub-geodata.js';

describe('site frame', () => {
  it('states a rounded origin with H0 from the terrain, and recovers a known EPSG:2056 point to sub-millimetre', async () => {
    const centre = { x: 2_600_123.4, y: 1_199_876.6 };
    const doc = await buildSiteContext({ centre, radius: 40, layers: ['terrain'], geodata: stubGeodata() });
    expect(doc.crs).toBe('EPSG:2056');
    expect(doc.verticalCrs).toBe('EPSG:5728');
    expect(doc.origin).toEqual([2_600_123, 1_199_877, Math.round(plane(2_600_123.5, 1_199_876.5))]);
    // The known node (2600150.5, 1199900): 0.5 m lattice, inside the site.
    const target = [2_600_150.5, 1_199_900, plane(2_600_150.5, 1_199_900)];
    let found = 0;
    for (const f of doc.layers[0].features.filter((f) => f.attributes.part === 'surface')) {
      const p = f.mesh!.positions;
      for (let i = 0; i < p.length; i += 3) {
        const x = f.origin[0] + p[i];
        const y = f.origin[1] + p[i + 1];
        if (Math.abs(x - target[0]) < 1e-6 && Math.abs(y - target[1]) < 1e-6) {
          expect(Math.abs(f.origin[2] + p[i + 2] - target[2])).toBeLessThan(1e-3);
          found++;
        }
      }
    }
    expect(found).toBeGreaterThanOrEqual(1);
  });

  it('gives each chunk its own origin on the grid lattice, relative to which positions stay small', async () => {
    const doc = await buildSiteContext({ centre: { x: 2_600_000, y: 1_200_000 }, radius: 100, layers: ['terrain'], geodata: stubGeodata() });
    const chunks = doc.layers[0].features.filter((f) => f.attributes.part === 'surface');
    expect(new Set(chunks.map((f) => f.origin.join())).size).toBe(chunks.length);
    for (const f of chunks) {
      expect(f.origin[2]).toBe(doc.origin[2]);
      // One assertion per chunk, not one per coordinate (120 000 expect calls took 1.7 s).
      let largest = 0;
      for (const v of f.mesh!.positions) largest = Math.max(largest, Math.abs(v));
      expect(largest).toBeLessThanOrEqual(64 + 50);
    }
  });
});

describe('refusals', () => {
  it('refuses a centre outside the provider coverage with a typed error and sends no request', async () => {
    const geodata = stubGeodata();
    await expect(buildSiteContext({ centre: { x: 500_000, y: 5_000_000 }, radius: 50, layers: ['terrain'], geodata })).rejects.toBeInstanceOf(SiteContextCoverageError);
    await expect(buildSiteContext({ centre: { x: 1_200_000, y: 2_600_000 }, radius: 50, layers: ['terrain'], geodata })).rejects.toThrow(/swapped/);
    expect(geodata.calls).toEqual([]);
  });

  it('refuses when the provider has no terrain anywhere in the site box', async () => {
    const geodata = stubGeodata({ noData: () => true, missingTiles: ['2600-1199'] });
    await expect(buildSiteContext({ centre: { x: 2_600_000, y: 1_200_000 }, radius: 50, layers: ['terrain', 'parcel'], geodata })).rejects.toBeInstanceOf(SiteContextCoverageError);
  });

  it('refuses a bad radius, an unknown layer and a grid too large', async () => {
    const geodata = stubGeodata();
    const centre = { x: 2_600_000, y: 1_200_000 };
    await expect(buildSiteContext({ centre, radius: 0, layers: ['terrain'], geodata })).rejects.toThrow(RangeError);
    await expect(buildSiteContext({ centre, radius: 50, layers: ['roads' as 'terrain'], geodata })).rejects.toThrow(/unknown site-context layer/);
    await expect(buildSiteContext({ centre, radius: 2000, layers: ['terrain'], resolution: 0.5, geodata })).rejects.toThrow(/coarser resolution/);
  });
});

describe('layers', () => {
  it('turns a buildings read that throws into an empty, incomplete layer with an error, not a failed build', async () => {
    const reader = async () => {
      throw new Error('root tileset unreachable');
    };
    const doc = await buildSiteContext({ centre: { x: 2_600_000, y: 1_200_000 }, radius: 20, layers: ['buildings'], geodata: stubGeodata(), buildings: { reader } });
    expect(doc.layers).toHaveLength(1);
    expect(doc.layers[0]).toMatchObject({ kind: 'buildings', features: [], complete: false });
    expect(doc.layers[0].issues).toEqual([expect.objectContaining({ code: 'buildings-fetch-failed', severity: 'error', message: expect.stringContaining('root tileset unreachable') })]);
  });

  it('emits layers in the requested order through onLayer', async () => {
    const seen: string[] = [];
    await buildSiteContext({
      centre: { x: 2_600_000, y: 1_200_000 },
      radius: 20,
      layers: ['parcel', 'terrain'],
      geodata: stubGeodata(),
      onLayer: (l) => seen.push(l.kind),
    });
    expect(seen).toEqual(['parcel', 'terrain']);
  });

  it('records the source tiles and their year in the terrain provenance', async () => {
    const doc = await buildSiteContext({ centre: { x: 2_600_000, y: 1_200_000 }, radius: 20, layers: ['terrain'], geodata: stubGeodata() });
    const prov = doc.layers[0].features[0].provenance;
    expect(prov.sources).toEqual([expect.objectContaining({ id: 'swissalti3d_2019_2600-1199', year: 2019 })]);
    expect(doc.layers[0].attribution[0].text).toBe('© swisstopo');
  });
});

describe('#10480 review: H0 is a terrain height only when terrain was read', () => {
  const centre = { x: 2_600_123.5, y: 1_199_876.5 };
  const noTiles = { reader: async () => { throw new Error('no tiles in this test'); } };

  it('says so when it read one, through the GLB and the summary', async () => {
    const doc = await buildSiteContext({ centre, radius: 20, layers: ['terrain'], geodata: stubGeodata() });
    expect(doc.originHeight).toEqual({ terrainHeight: doc.origin[2] });
    expect(decodeSiteContextGlb(encodeSiteContextGlb(doc)).originHeight).toEqual(doc.originHeight);
    expect(summarizeSiteContext(doc).originHeight).toEqual(doc.originHeight);
  });

  it('gives no terrain height, with the reason, for a buildings-only site; H0 0 is only a frame offset', async () => {
    const doc = await buildSiteContext({ centre, radius: 20, layers: ['buildings'], geodata: stubGeodata(), buildings: noTiles });
    expect(doc.originHeight?.terrainHeight).toBeNull();
    expect(doc.originHeight?.reason).toMatch(/no terrain was requested/);
    expect(decodeSiteContextGlb(encodeSiteContextGlb(doc)).originHeight).toEqual(doc.originHeight);
  });

  it('gives no terrain height, with the read error, when the elevation grid fails', async () => {
    const geodata = { ...stubGeodata(), elevationGrid: async () => { throw new Error('STAC unreachable'); } };
    const doc = await buildSiteContext({ centre, radius: 20, layers: ['terrain', 'parcel'], geodata });
    expect(doc.originHeight).toEqual({ terrainHeight: null, reason: expect.stringContaining('STAC unreachable') });
    expect(summarizeSiteContext(doc).originHeight?.terrainHeight).toBeNull();
  });
});
