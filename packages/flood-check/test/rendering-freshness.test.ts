/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A rendering confirmation vouches only for rasters fetched close to it (review
 * finding "absence-reads-as-success" on the provider): once the WMS stops
 * rendering, an all-transparent raster must not reuse an old confirmation and
 * read as "no runoff mapped".
 */

import { describe, expect, it } from 'vitest';
import { createBafuRunoffProvider, type CachedHazardResponse } from '../src/bafu/provider.js';
import { checkFloodExposure } from '../src/check/check.js';
import { runFloodCheck } from '../src/check/run.js';
import { toPropertySets } from '../src/psets.js';
import { BAFU_CLASSES } from '../src/bafu/dataset.js';
import { extractModelFacts } from '../src/model/extract.js';
import { boxFacts, candidate, CONFIRMED, E0, fixture, flatTerrain, N0, rgbaPng, syntheticRaster, NO_OTHER_BUILDINGS } from './helpers.js';
import { parseStep, syntheticHouse } from './synthetic-model.js';

const REFERENCE_BBOX = '2599560,1199720,2599569,1199729';
const CLEAR = [0, 0, 0, 0];

/** A WMS whose reference area renders while `state.up`, and answers transparent everywhere else (and everywhere when down). */
function switchableWms(state: { up: boolean; malformedReference?: boolean }) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string) => {
    urls.push(String(input));
    const q = new URL(String(input)).searchParams;
    const reference = q.get('BBOX') === REFERENCE_BBOX;
    const png = reference && state.malformedReference
      ? new TextEncoder().encode('not a png at all')
      : reference && state.up
        ? fixture('bern-uniform-9px.png')
        : rgbaPng(Number(q.get('WIDTH')), Number(q.get('HEIGHT')), () => CLEAR);
    return new Response(new Blob([png as BlobPart]), { headers: { 'content-type': 'image/png' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls, references: () => urls.filter((u) => new URL(u).searchParams.get('BBOX') === REFERENCE_BBOX).length };
}

const facts = async () => extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02' })), { expectedCrs: 'EPSG:2056', groundStorey: 'EG' });
const door = (r: Awaited<ReturnType<typeof runFloodCheck>>) => r.results.find((x) => x.candidate.name === 'Haustür')!;

describe('a rendering confirmation and the rasters it vouches for', () => {
  it('the reported case: confirmed once, then the WMS stops rendering; the next transparent raster is not "no runoff mapped"', async () => {
    const state = { up: true };
    const wms = switchableWms(state);
    let t = Date.UTC(2026, 10, 15, 10, 0);
    const provider = createBafuRunoffProvider({ fetch: wms.fetchImpl, now: () => new Date(t) });
    const f = await facts();
    const first = await runFloodCheck(f, provider, flatTerrain(499.95), { otherBuildings: NO_OTHER_BUILDINGS });
    expect(door(first).outcome).toBe('no-runoff-mapped');
    expect(first.provenance.renderingCheckedAt).toBe('2026-11-15T10:00:00.000Z');

    state.up = false;
    t += 60 * 60 * 1000; // an hour later, same provider
    const second = await runFloodCheck(f, provider, flatTerrain(499.95), { otherBuildings: NO_OTHER_BUILDINGS });
    expect(wms.references()).toBe(2);
    expect(door(second)).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'layer-not-confirmed' });
    expect(second.results.map((r) => r.outcome)).not.toContain('no-runoff-mapped');
    expect(second.layerCheck.confirmation).toMatchObject({ confirmed: false, retrievedAt: '2026-11-15T11:00:00.000Z' });
  });

  for (const [label, ageMs, reused] of [
    ['exactly 5 min', 5 * 60 * 1000, true],
    ['5 min and 1 ms', 5 * 60 * 1000 + 1, false],
  ] as const) {
    it(`a positive confirmation ${label} old is ${reused ? 'reused' : 're-requested'}`, async () => {
      const state = { up: true };
      const wms = switchableWms(state);
      let t = Date.UTC(2026, 10, 15, 10, 0);
      const provider = createBafuRunoffProvider({ fetch: wms.fetchImpl, now: () => new Date(t) });
      expect(await provider.confirmRendering!()).toMatchObject({ confirmed: true });
      state.up = false;
      t += ageMs;
      const again = await provider.confirmRendering!();
      expect(wms.references()).toBe(reused ? 1 : 2);
      expect(again.confirmed).toBe(reused);
    });
  }

  it('a caller\'s long-lived cache neither keeps an old confirmation alive nor serves a transparent raster', async () => {
    const store = new Map<string, CachedHazardResponse>();
    const cache = { get: (k: string) => store.get(k), set: (k: string, v: CachedHazardResponse) => void store.set(k, v) };
    const state = { up: true };
    const wms = switchableWms(state);
    let t = Date.UTC(2026, 10, 15, 10, 0);
    const f = await facts();
    const day1 = createBafuRunoffProvider({ fetch: wms.fetchImpl, cache, now: () => new Date(t) });
    expect(door(await runFloodCheck(f, day1, flatTerrain(499.95), { otherBuildings: NO_OTHER_BUILDINGS })).outcome).toBe('no-runoff-mapped');
    // The transparent building raster was not cached; the classified reference was.
    expect([...store.keys()].map((k) => new URL(k).searchParams.get('BBOX'))).toEqual([REFERENCE_BBOX]);

    state.up = false;
    t += 24 * 60 * 60 * 1000;
    const day2 = createBafuRunoffProvider({ fetch: wms.fetchImpl, cache, now: () => new Date(t) });
    const r = await runFloodCheck(f, day2, flatTerrain(499.95), { otherBuildings: NO_OTHER_BUILDINGS });
    expect(wms.references()).toBe(2);
    expect(door(r)).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'layer-not-confirmed' });
  });

  it('a malformed or transparent reference answer is not cached, so the next attempt can confirm', async () => {
    const store = new Map<string, CachedHazardResponse>();
    const cache = { get: (k: string) => store.get(k), set: (k: string, v: CachedHazardResponse) => void store.set(k, v) };
    const state = { up: false, malformedReference: true };
    const wms = switchableWms(state);
    const provider = createBafuRunoffProvider({ fetch: wms.fetchImpl, cache, now: () => new Date(Date.UTC(2026, 10, 15, 10, 0)) });
    expect(await provider.confirmRendering!()).toMatchObject({ confirmed: false });
    state.malformedReference = false;
    expect(await provider.confirmRendering!()).toMatchObject({ confirmed: false, detail: expect.stringMatching(/without any mapped class/) });
    expect(store.size).toBe(0);
    state.up = true;
    expect(await provider.confirmRendering!()).toMatchObject({ confirmed: true });
    expect(wms.references()).toBe(3);
  });

  for (const [label, gapMs, vouches] of [
    ['exactly 5 min', 5 * 60 * 1000, true],
    ['5 min and 1 ms', 5 * 60 * 1000 + 1, false],
  ] as const) {
    it(`a positive confirmation fetched ${label} apart from the raster ${vouches ? 'vouches for it' : 'does not vouch for it'}`, () => {
      const raster = syntheticRaster(E0 - 10, N0 - 10, 80, 60, 0.5); // wholly transparent, retrieved at PROVENANCE.retrievedAt
      const confirmation = { ...CONFIRMED, retrievedAt: new Date(Date.parse(CONFIRMED.retrievedAt) - gapMs).toISOString() };
      const r = checkFloodExposure(boxFacts([candidate({ position: { x: E0 + 10, y: N0 }, level: 500 })]), raster, flatTerrain(499.95), {
        renderingConfirmation: confirmation,
        otherBuildings: NO_OTHER_BUILDINGS,
      });
      expect(r.layerCheck.confirmationApplies).toBe(vouches);
      expect(r.results[0]).toMatchObject(vouches ? { outcome: 'no-runoff-mapped' } : { outcome: 'unclassified', unclassifiedReason: 'layer-not-confirmed' });
      expect(r.provenance.renderingCheckedAt).toBe(confirmation.retrievedAt);
      const site = Object.fromEntries(toPropertySets(r, BAFU_CLASSES).site.Properties.map((p) => [p.Name, p.NominalValue]));
      expect(site).toMatchObject({ LayerRenderingConfirmed: vouches, LayerRenderingCheckedAt: confirmation.retrievedAt });
      if (!vouches) expect(r.warnings.join()).toMatch(/fetched 5\.0 min apart from the raster, more than 5 min/);
    });
  }
});
