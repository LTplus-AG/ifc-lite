/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review round on head af83417c: a reader must report every item it was
 * given, not "the first one" (outlines); one caller's abort must not reach
 * another caller's rendering check (provider).
 */

import { describe, expect, it } from 'vitest';
import { createBafuRunoffProvider } from '../src/bafu/provider.js';
import { checkFloodExposure } from '../src/check/check.js';
import { extractModelFacts } from '../src/model/extract.js';
import { footprintConcerns } from '../src/model/facts.js';
import { CELL_NO_RUNOFF, type MapPoint } from '../src/types.js';
import { CODE, CONFIRMED, fixture, flatTerrain } from './helpers.js';
import { raster } from './candidate-fixtures.js';
import { parseStep, syntheticHouse, type Extra } from './synthetic-model.js';

const deep = CODE['depth-gt-0.25'];

/** One ground slab whose Body holds two disjoint extrusions: wing A (0..20) and wing B (30..40), both 10 m deep. */
function twoWingSlab(b: Extra) {
  const wingA = b.rectExtrusion(10, 5, 20, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1));
  const wingB = b.rectExtrusion(35, 5, 10, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1));
  const slab = b.add(`IFCSLAB(${b.guid()},$,'Platte zwei Flügel',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([wingA, wingB])},$,.FLOOR.)`);
  b.contain(b.storeys.eg.id, slab);
  b.contain(b.storeys.ug.id, b.add(`IFCBOILER(${b.guid()},$,'Kessel Flügel B',$,$,#${b.place(b.storeys.ug.pl, 35, 5, 0)},#${b.shape([b.rectExtrusion(0, 0, 0.5, 0.5, 1, b.axis(0, 0, 0), b.dir(0, 0, 1))])},$,.WATER.)`));
}

/** A deep class in a 4 m band round wing B (30..40 x 0..10), wing B itself raised (transparent). */
const roundWingB = (l: MapPoint) => {
  const inside = l.x >= 30 && l.x <= 40 && l.y >= 0 && l.y <= 10;
  return !inside && l.x > 26 && l.x < 44 && l.y > -4 && l.y < 14 ? deep : CELL_NO_RUNOFF;
};

describe('a slab body with two disjoint extrusions', () => {
  it('gives an outline ring for each, so the second wing is inside the footprint', async () => {
    const facts = extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', slab: false, extra: twoWingSlab })), { expectedCrs: 'EPSG:2056' });
    expect(facts.footprint.rings).toHaveLength(2);
    expect(footprintConcerns(facts.footprint).worst).toBe('complete');
    const r = checkFloodExposure(facts, raster(roundWingB), flatTerrain(499.95), { renderingConfirmation: CONFIRMED });
    const boiler = r.results.find((x) => x.candidate.name === 'Kessel Flügel B')!;
    expect(boiler.outcome).not.toBe('no-runoff-mapped');
    expect(boiler.anchorBasis).toBe('nearest-outline-point');
  });
});

describe('two concurrent rendering checks with their own signals', () => {
  it('the first caller aborting does not reject the second, which still gets the confirmation', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      await new Promise<void>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        void gate.then(resolve);
      });
      return new Response(new Blob([fixture('bern-uniform-9px.png') as BlobPart]), { headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof fetch;
    const provider = createBafuRunoffProvider({ fetch: fetchImpl });
    const first = new AbortController();
    const a = provider.confirmRendering!(first.signal);
    const b = provider.confirmRendering!(new AbortController().signal);
    first.abort(new Error('first caller cancelled'));
    await expect(a).rejects.toThrow('first caller cancelled');
    release!();
    await expect(b).resolves.toMatchObject({ confirmed: true });
  });

  it('a caller aborting its own wait is released at once, and the shared check still completes for later callers', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      await gate;
      return new Response(new Blob([fixture('bern-uniform-9px.png') as BlobPart]), { headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof fetch;
    const provider = createBafuRunoffProvider({ fetch: fetchImpl });
    const mine = new AbortController();
    const a = provider.confirmRendering!(mine.signal);
    mine.abort(new Error('mine cancelled'));
    await expect(a).rejects.toThrow('mine cancelled');
    release!();
    await expect(provider.confirmRendering!()).resolves.toMatchObject({ confirmed: true });
    expect(calls).toBe(1);
  });
});

