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

describe('the audit: no reader stops at the first item or match', () => {
  it('a slab body with one readable and one unreadable item is partial, with the readable ring kept', async () => {
    const facts = extractModelFacts(await parseStep(syntheticHouse({
      verticalDatum: 'LN02',
      slab: false,
      extra: (b) => {
        const wingA = b.rectExtrusion(10, 5, 20, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1));
        const brep = b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`);
        b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Platte teils',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([wingA, brep])},$,.FLOOR.)`));
      },
    })), { expectedCrs: 'EPSG:2056' });
    expect(facts.footprint.rings).toHaveLength(1);
    expect(footprintConcerns(facts.footprint).worst).toBe('partial');
    expect(facts.footprint.quality?.unreadable.map((u) => u.reason).join()).toMatch(/only in part \(1 of 2 items\)/);
  });

  it('a wall axis with one readable and one unreadable curve is partial', async () => {
    const facts = extractModelFacts(await parseStep(syntheticHouse({
      verticalDatum: 'LN02',
      slab: false,
      extra: (b) => {
        const good = b.add(`IFCPOLYLINE((#${b.pt2(20, 0)},#${b.pt2(20, 10)}))`);
        const bad = b.add(`IFCCOMPOSITECURVE((),.F.)`);
        const wall = b.add(`IFCWALL(${b.guid()},$,'Wand Ost',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([good, bad], 'Axis', 'Curve2D')},$,.STANDARD.)`);
        b.pset(wall, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
        b.contain(b.storeys.eg.id, wall);
      },
    })), { expectedCrs: 'EPSG:2056' });
    expect(facts.footprint.quality?.unreadable.map((u) => u.reason).join()).toMatch(/axis can be read only in part \(1 of 2 curves\)/);
    expect(footprintConcerns(facts.footprint).partial).toBe(true);
  });

  it('two same-named property sets that disagree on IsExternal keep the element in the façade', async () => {
    const facts = extractModelFacts(await parseStep(syntheticHouse({
      verticalDatum: 'LN02',
      extra: (b) => {
        const door = b.add(`IFCDOOR(${b.guid()},$,'Tür zwei Psets',$,$,#${b.place(b.storeys.eg.pl, 10, 5, 0)},#${b.shape([b.rectExtrusion(0, 0, 1, 0.1, 2.1, b.axis(0, 0, 0), b.dir(0, 0, 1))])},$,2.1,1.,.DOOR.,$,$)`);
        b.pset(door, 'Pset_DoorCommon', 'IsExternal', 'IFCBOOLEAN(.F.)');
        b.pset(door, 'Pset_DoorCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
        b.contain(b.storeys.eg.id, door);
      },
    })), { expectedCrs: 'EPSG:2056' });
    expect(facts.candidates.find((c) => c.name === 'Tür zwei Psets')?.selectedBecause).toMatch(/IsExternal/);
  });

  it('an opening filled twice takes the lowest bound of its fillings, not the first one\'s', async () => {
    const facts = extractModelFacts(await parseStep(syntheticHouse({
      verticalDatum: 'LN02',
      extra: (b) => {
        // An upper-storey opening on the east face (504.5 m), its body unreadable, with no host: judged on its own.
        const brep = b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`);
        const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung doppelt',$,$,#${b.place(b.storeys.og.pl, 20, 5, 0.5)},#${b.shape([brep])},$,.OPENING.)`);
        // Two windows filling it, both stating IsExternal = false (skipped): 0.5 m tall (bound 504 m) first, 3 m tall (bound 501.5 m) second.
        for (const [name, h] of [['Fenster klein', '0.5'], ['Fenster gross', '3.']] as const) {
          const w = b.add(`IFCWINDOW(${b.guid()},$,'${name}',$,$,#${b.place(b.storeys.og.pl, 20, 5, 0.5)},$,$,${h},1.,.WINDOW.,$,$)`);
          b.pset(w, 'Pset_WindowCommon', 'IsExternal', 'IFCBOOLEAN(.F.)');
          b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${opening},#${w})`);
          b.contain(b.storeys.og.id, w);
        }
      },
    })), { expectedCrs: 'EPSG:2056' });
    expect(facts.candidates.find((c) => c.name === 'Öffnung doppelt')).toMatchObject({ levelIsUpperEstimate: true });
  });
});
