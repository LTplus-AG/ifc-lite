/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { DATASETS } from '../src/attribution.js';
import { buildingTiles } from '../src/buildings.js';
import { MAP_LAYERS } from '../src/layers.js';
import { fixture, json, mockFetch, testClient } from './helpers/mock-fetch.js';

const BOX = { minX: 2_600_300, minY: 1_199_400, maxX: 2_600_600, maxY: 1_199_700 };

function server() {
  return mockFetch(
    (url) =>
      url.pathname.endsWith('/collections/ch.swisstopo.swissbuildings3d_3_0/items')
        ? json(fixture('stac-swissbuildings3d-items-bern.json'))
        : undefined,
    (url) =>
      url.host === 'data.geo.admin.ch' && url.pathname.endsWith('.zip')
        ? new Response(new Uint8Array(1), { status: 206, headers: { 'content-range': 'bytes 0-0/14523412' } })
        : undefined,
  );
}

describe('buildingTiles (recorded STAC response over Bern)', () => {
  it('returns the newest tiled CityGML asset per sheet, never the nationwide file', async () => {
    const m = server();
    const res = await buildingTiles(testClient(m.fetch), BOX);
    expect(res.assets).toHaveLength(1);
    const a = res.assets[0];
    expect(a).toMatchObject({
      tileId: '1166-42',
      format: 'citygml',
      size: 14_523_412,
      extentApproximate: true,
      crs: 'EPSG:2056',
      verticalCrs: 'EPSG:5728',
      acquired: '2021-01-01T00:00:00Z',
    });
    expect(a.url).toMatch(/swissbuildings3d_3_0_2021_1166-42_2056_5728\.citygml\.zip$/);
    expect(a.extent.minX).toBeLessThan(BOX.minX);
    expect(a.extent.maxY).toBeGreaterThan(BOX.maxY);
    expect(res.attribution[0].datasetId).toBe('swissbuildings3d');
    // STAC bbox is WGS84 degrees, padded around the LV95 box.
    const bbox = m.calls[0].searchParams.get('bbox')?.split(',').map(Number) ?? [];
    expect(bbox[0]).toBeGreaterThan(7.4);
    expect(bbox[0]).toBeLessThan(7.5);
  });

  it('picks the newest year that has the format (dwg: 2021 over 2018), and skips sizing on request', async () => {
    const m = server();
    const res = await buildingTiles(testClient(m.fetch), BOX, { formats: ['dwg'], resolveSize: false });
    expect(res.assets.map((a) => a.url)).toEqual([
      'https://data.geo.admin.ch/ch.swisstopo.swissbuildings3d_3_0/swissbuildings3d_3_0_2021_1166-42/swissbuildings3d_3_0_2021_1166-42_2056_5728.dwg.zip',
    ]);
    expect(res.assets[0].size).toBeNull();
    expect(m.calls).toHaveLength(1);
  });
});

describe('attribution and layer descriptors', () => {
  it('gives every dataset display text, terms URL and a dated (or explicitly unread) check', () => {
    for (const d of Object.values(DATASETS)) {
      expect(d.text.length).toBeGreaterThan(0);
      expect(d.termsUrl).toMatch(/^https?:\/\//);
      if (d.termsVerifiedOn === null) expect(d.restrictions.join(' ')).toMatch(/could not|404|not checked/i);
      else expect(d.termsVerifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('describes tile services with placeholders and attribution, without fetching', () => {
    for (const l of MAP_LAYERS) {
      expect(l.attribution.text.length).toBeGreaterThan(0);
      for (const s of l.services) {
        if (s.type === 'WMTS') expect(s.urlTemplate).toContain('{TileMatrix}/{TileCol}/{TileRow}');
        else expect(s.crs).toContain('EPSG:2056');
      }
    }
    expect(MAP_LAYERS.find((l) => l.kind === 'hazard')?.id).toBe('ch.bafu.gefaehrdungskarte-oberflaechenabfluss');
  });
});
