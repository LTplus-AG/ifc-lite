/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { geocode, lv95FromSearchAttrs } from '../src/geocode.js';
import { CANTON_OEREB_SERVICES } from '../src/oereb-cantons.js';
import { OerebExtractUnavailableError, extractUrls, oerebExtractForEgrid, oerebExtractsAtPoint, serviceBaseFromExtractUrl } from '../src/oereb.js';
import { parcelByEgrid, parcelsAtPoint } from '../src/parcel.js';
import { fixture, json, mockFetch, testClient } from './helpers/mock-fetch.js';

const onPath = (suffix: string, body: unknown) => (url: URL) => (url.pathname.endsWith(suffix) ? json(body) : undefined);
const onLayer = (path: string, layer: string, body: unknown) => (url: URL) =>
  url.pathname.endsWith(path) && (url.searchParams.get('layer') === layer || url.searchParams.get('layers') === `all:${layer}`)
    ? json(body)
    : undefined;

describe('geocode (recorded SearchServer response, Bundesplatz 3, Bern)', () => {
  it('returns LV95 easting/northing, with the service\'s swapped x/y untangled', async () => {
    const m = mockFetch(onPath('/SearchServer', fixture('search-bundesplatz-3-bern.json')));
    const res = await geocode(testClient(m.fetch), 'Bundesplatz 3, Bern');
    expect(res.crs).toBe('EPSG:2056');
    expect(res.candidates[0]).toMatchObject({ label: 'Bundesplatz 3 3011 Bern', x: 2_600_423.25, y: 1_199_521.125, origin: 'address' });
    expect(res.attribution[0].text).toBe('© swisstopo');
    const q = m.calls[0].searchParams;
    expect([q.get('sr'), q.get('type'), q.get('origins')]).toEqual(['2056', 'locations', 'address']);
  });

  it('fails loudly on a result without coordinates, and never asks the service to drop them', async () => {
    // With returnGeometry=false the live service omits x/y (2026-11-15); a silent skip hid that.
    const recorded = fixture<{ results: Array<{ attrs: Record<string, unknown> }> }>('search-bundesplatz-3-bern.json');
    const stripped = { results: recorded.results.map((r) => ({ ...r, attrs: { ...r.attrs, x: undefined, y: undefined } })) };
    const m = mockFetch(onPath('/SearchServer', stripped));
    await expect(geocode(testClient(m.fetch), 'Bundesplatz 3, Bern')).rejects.toThrow(/no coordinates/);
    expect(m.calls[0].searchParams.get('returnGeometry')).toBeNull();
  });

  it.each([NaN, 0, -1, 51, 2.5, Infinity])('rejects limit %s instead of clamping it', async (limit) => {
    const m = mockFetch(onPath('/SearchServer', fixture('search-bundesplatz-3-bern.json')));
    await expect(geocode(testClient(m.fetch), 'Bern', { limit })).rejects.toThrow(RangeError);
    expect(m.calls).toHaveLength(0);
  });

  it('sends the limits 1 and 50 as given', async () => {
    const m = mockFetch(onPath('/SearchServer', fixture('search-bundesplatz-3-bern.json')));
    for (const limit of [1, 50]) await geocode(testClient(m.fetch), 'Bern', { limit });
    expect(m.calls.map((c) => c.searchParams.get('limit'))).toEqual(['1', '50']);
  });

  it('refuses coordinates that are LV95 in neither axis order', () => {
    expect(lv95FromSearchAttrs(1_199_521, 2_600_423)).toEqual({ e: 2_600_423, n: 1_199_521 });
    expect(lv95FromSearchAttrs(2_600_423, 1_199_521)).toEqual({ e: 2_600_423, n: 1_199_521 });
    expect(() => lv95FromSearchAttrs(46.9, 7.44)).toThrow(/outside LV95/);
  });
});

describe('parcels (recorded cadastral web map responses)', () => {
  const layer = 'ch.kantone.cadastralwebmap-farbe';

  it('finds a parcel by EGRID with typed attributes and LV95 geometry', async () => {
    const m = mockFetch(onLayer('/find', layer, fixture('find-parcel-CH134676354275.json')));
    const p = await parcelByEgrid(testClient(m.fetch), 'ch134676354275');
    expect(p).toMatchObject({ egrid: 'CH134676354275', canton: 'BE', number: '816', cadastralDistrict: 'BE0200000042', sourceLayer: layer, crs: 'EPSG:2056' });
    expect(p?.geometry.type).toBe('Polygon');
    // The ring's bbox is 21.8 × 65.1 m; the parcel is a narrow strip inside it.
    expect(p?.computedArea).toBeGreaterThan(700);
    expect(p?.computedArea).toBeLessThan(21.8 * 65.1);
    const q = m.calls[0].searchParams;
    expect([q.get('searchField'), q.get('contains'), q.get('sr')]).toEqual(['egris_egrid', 'false', '2056']);
  });

  it('rejects malformed EGRIDs before any request', async () => {
    const m = mockFetch();
    await expect(parcelByEgrid(testClient(m.fetch), 'CH-1234')).rejects.toThrow(/not an EGRID/);
    expect(m.calls).toHaveLength(0);
  });

  it('finds parcels at a point', async () => {
    const m = mockFetch(onLayer('/identify', layer, fixture('identify-parcel-2600500-1199700.json')));
    const ps = await parcelsAtPoint(testClient(m.fetch), 2_600_500, 1_199_700);
    expect(ps.map((p) => p.egrid)).toEqual(['CH134676354275']);
    expect(m.calls[0].searchParams.get('geometry')).toBe('2600500,1199700');
  });
});

describe('ÖREB extract resolution', () => {
  const register = 'ch.swisstopo-vd.stand-oerebkataster';

  it('takes the service from the federal register (recorded, Bern)', async () => {
    const m = mockFetch(onLayer('/find', register, fixture('find-oereb-CH134676354275.json')));
    const ref = await oerebExtractForEgrid(testClient(m.fetch), 'CH134676354275');
    expect(ref).toMatchObject({ source: 'federal-register', canton: 'BE', municipality: 'Bern', serviceBase: 'https://www.oereb2.apps.be.ch' });
    expect(ref?.urls.json).toBe('https://www.oereb2.apps.be.ch/extract/json/?EGRID=CH134676354275');
    expect(ref?.tableEntry?.base).toBe(ref?.serviceBase);
  });

  it('falls back to the canton table when the register has no record', async () => {
    const m = mockFetch(
      onLayer('/find', register, { results: [] }),
      onLayer('/find', 'ch.kantone.cadastralwebmap-farbe', fixture('find-parcel-CH134676354275.json')),
    );
    const ref = await oerebExtractForEgrid(testClient(m.fetch), 'CH134676354275');
    expect(ref).toMatchObject({ source: 'canton-table', canton: 'BE', serviceBase: 'https://www.oereb2.apps.be.ch' });
  });

  it('does not use the canton table when the register has the parcel but no extract URL', async () => {
    const recorded = fixture<{ results: Array<{ attributes: Record<string, unknown> }> }>('find-oereb-CH134676354275.json');
    const noUrl = structuredClone(recorded);
    for (const r of noUrl.results) delete r.attributes.oereb_extract_url;
    const m = mockFetch(
      onLayer('/find', register, noUrl),
      onLayer('/find', 'ch.kantone.cadastralwebmap-farbe', fixture('find-parcel-CH134676354275.json')),
    );
    const err = await oerebExtractForEgrid(testClient(m.fetch), 'CH134676354275').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OerebExtractUnavailableError);
    expect(err).toMatchObject({ egrid: 'CH134676354275' });
    expect(m.calls.every((c) => c.searchParams.get('layer') === register)).toBe(true);
  });

  it('reads extract references at a point', async () => {
    const recorded = fixture<{ results: unknown[] }>('find-oereb-CH134676354275.json');
    const m = mockFetch(onLayer('/identify', register, recorded));
    const refs = await oerebExtractsAtPoint(testClient(m.fetch), 2_600_500, 1_199_700);
    expect(refs.extracts.map((r) => r.egrid)).toEqual(['CH134676354275']);
    expect(refs.unavailable).toEqual([]);
  });

  it('reports a parcel listed without an extract URL as unavailable, not as no record', async () => {
    const recorded = fixture<{ results: Array<{ attributes: Record<string, unknown> }> }>('find-oereb-CH134676354275.json');
    const noUrl = structuredClone(recorded);
    for (const r of noUrl.results) delete r.attributes.oereb_extract_url;
    const m = mockFetch(onLayer('/identify', register, noUrl));
    const refs = await oerebExtractsAtPoint(testClient(m.fetch), 2_600_500, 1_199_700);
    expect(refs.extracts).toEqual([]);
    expect(refs.unavailable.map((u) => u.egrid)).toEqual(['CH134676354275']);
  });

  it('derives the service base from the extract URL shapes the register uses', () => {
    expect(serviceBaseFromExtractUrl('https://www.oereb2.apps.be.ch/extract/url/?EGRID=CH1')).toBe('https://www.oereb2.apps.be.ch');
    // Fribourg's register entry has no slash before the query.
    expect(serviceBaseFromExtractUrl('https://maps.fr.ch/RDPPF_ws/RdppfSVC.svc/extract/url?EGRID=CH2')).toBe(
      'https://maps.fr.ch/RDPPF_ws/RdppfSVC.svc',
    );
    // Zug's `oereb_webservice` field held a full extract URL; it is not a base.
    expect(serviceBaseFromExtractUrl('https://oereb.zg.ch/oereb')).toBeNull();
    expect(extractUrls('https://x.test/oereb/', 'CH1').pdf).toBe('https://x.test/oereb/extract/pdf/?EGRID=CH1');
  });

  it('has one dated, https entry per canton, each marked verified or not', () => {
    const codes = CANTON_OEREB_SERVICES.map((s) => s.canton);
    expect(new Set(codes).size).toBe(26);
    for (const s of CANTON_OEREB_SERVICES) {
      expect(s.base).toMatch(/^https:\/\/[^?]+[^/]$/);
      expect(s.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['verified', 'unverified']).toContain(s.verification);
    }
    expect(CANTON_OEREB_SERVICES.filter((s) => s.verification === 'unverified').map((s) => s.canton)).toEqual(['VS']);
  });
});
