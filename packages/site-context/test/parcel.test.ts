/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The parcel layer: draping, densification, attributes and the honesty rules. */

import { describe, expect, it } from 'vitest';
import { buildSiteContext } from '../src/build.js';
import { densifyRing, DRAPE_OFFSET, RIBBON_WIDTH } from '../src/parcel-mesh.js';
import { paraboloid, squareParcel, stubGeodata, type StubOptions } from './stub-geodata.js';

const CENTRE = { x: 2_600_000, y: 1_200_000 };

async function parcelLayer(opts: StubOptions = {}, radius = 60) {
  const geodata = stubGeodata(opts);
  const doc = await buildSiteContext({ centre: CENTRE, radius, layers: ['parcel'], geodata });
  return { layer: doc.layers[0], doc, geodata };
}

describe('parcel ribbon', () => {
  it('densifies the boundary to about a metre', () => {
    const pts = densifyRing([[0, 0], [10, 0], [10, 3.5], [0, 3.5], [0, 0]]);
    expect(pts).toHaveLength(10 + 4 + 10 + 4);
    for (let i = 0; i < pts.length; i++) {
      const q = pts[(i + 1) % pts.length];
      expect(Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1])).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('drapes every ribbon vertex 0.1 m above the terrain under it', async () => {
    const { layer } = await parcelLayer({ height: paraboloid });
    const f = layer.features[0];
    const p = f.mesh!.positions;
    expect(p.length).toBeGreaterThan(0);
    for (let i = 0; i < p.length; i += 3) {
      const x = f.origin[0] + p[i];
      const y = f.origin[1] + p[i + 1];
      // Bilinear on a 0.5 m grid deviates from the paraboloid by at most res²/8 · |f''| = 0.0625 mm here.
      expect(Math.abs(f.origin[2] + p[i + 2] - (paraboloid(x, y) + DRAPE_OFFSET))).toBeLessThan(1e-3);
    }
  });

  it('is a closed ribbon about 0.3 m wide around the parcel', async () => {
    const { layer } = await parcelLayer();
    const f = layer.features[0];
    const p = f.mesh!.positions;
    // 40 m square densified at 1 m: 160 points, a left/right vertex pair each, two triangles per segment.
    expect(p.length / 3).toBe(2 * 160);
    expect(f.mesh!.indices.length / 3).toBe(2 * 160);
    // Mid-edge pairs sit RIBBON_WIDTH apart, straddling the boundary.
    const width = Math.hypot(p[6] - p[9], p[7] - p[10]);
    expect(width).toBeCloseTo(RIBBON_WIDTH, 5);
  });
});

describe('parcel attributes', () => {
  it('lays out Pset_LandRegistration, area, canton, source layer and the ÖREB link', async () => {
    const { layer } = await parcelLayer();
    expect(layer.complete).toBe(true);
    const f = layer.features[0];
    expect(f.ifcType).toBe('IfcSite');
    expect(f.id).toBe('parcel:CH123456789012');
    expect(f.attributes).toMatchObject({
      Pset_LandRegistration: { LandID: 'CH123456789012', LandTitleID: '4711' },
      area: 1600,
      canton: 'BE',
      sourceLayer: 'ch.kantone.cadastralwebmap-farbe',
      oerebExtractUrl: 'https://oereb.example.test/oereb/extract/url/?EGRID=CH123456789012',
      oerebSource: 'federal-register',
    });
  });

  it('carries the unverified cadastral terms as attribution and as an issue', async () => {
    const { layer } = await parcelLayer();
    expect(layer.attribution.map((a) => a.datasetId)).toEqual(['cadastre', 'oerebAvailability']);
    const terms = layer.issues.find((i) => i.code === 'terms-unverified');
    expect(terms?.severity).toBe('warning');
    expect(terms?.message).toMatch(/Cadastral surveying/);
  });

  it('keeps the parcel when the ÖREB lookup fails, and says so on the layer', async () => {
    const { layer } = await parcelLayer({ oereb: 'fail' });
    expect(layer.features).toHaveLength(1);
    expect(layer.features[0].attributes.oerebExtractUrl).toBeNull();
    expect(layer.complete).toBe(false);
    expect(layer.issues.find((i) => i.code === 'oereb-lookup-failed')?.message).toMatch(/stub ÖREB service unavailable/);
  });

  it('says when no parcel was found instead of returning a silent empty layer', async () => {
    const { layer } = await parcelLayer({ parcel: null });
    expect(layer.features).toEqual([]);
    expect(layer.complete).toBe(false);
    expect(layer.issues[0].code).toBe('parcel-not-found');
  });

  it('takes the parcel by EGRID when the subject names one', async () => {
    const geodata = stubGeodata();
    const doc = await buildSiteContext({ centre: CENTRE, radius: 60, layers: ['parcel'], subject: { egrid: 'CH123456789012' }, geodata });
    expect(doc.layers[0].features).toHaveLength(1);
    expect(geodata.calls).toContain('parcelById CH123456789012');
  });

  it('looks the parcel up at the footprint centroid when a footprint is given', async () => {
    const geodata = stubGeodata();
    const footprint = [[{ x: 2_600_010, y: 1_199_990 }, { x: 2_600_014, y: 1_199_990 }, { x: 2_600_014, y: 1_199_994 }, { x: 2_600_010, y: 1_199_994 }]];
    await buildSiteContext({ centre: CENTRE, radius: 60, layers: ['parcel'], subject: { footprint }, geodata });
    expect(geodata.calls).toContain('parcelsAtPoint 2600012,1199992');
  });
});

describe('parcel over missing terrain', () => {
  it('breaks the ribbon where there is no terrain and never invents a height', async () => {
    // The parcel reaches 70 m east of the centre; the site ends at 40 m.
    const parcel = squareParcel(2_600_040, 1_200_000, 30);
    const { layer } = await parcelLayer({ parcel }, 40);
    const issue = layer.issues.find((i) => i.code === 'parcel-undraped-vertices');
    expect(issue?.count).toBeGreaterThan(0);
    expect(layer.complete).toBe(false);
    const f = layer.features[0];
    const p = f.mesh!.positions;
    for (let i = 0; i < p.length; i += 3) expect(f.origin[0] + p[i]).toBeLessThanOrEqual(2_600_040 + 1e-6);
  });
});
