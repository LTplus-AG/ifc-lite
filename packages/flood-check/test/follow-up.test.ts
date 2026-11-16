/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The flood-check follow-up: slab holes cut by a Boolean DIFFERENCE, roofing that is not a slab, and small leftovers. */

import { describe, expect, it } from 'vitest';
import { extractModelFacts } from '../src/model/extract.js';
import { parseStep, syntheticHouse, type Extra } from './synthetic-model.js';

const extract = async (extra: (b: Extra) => void) =>
  extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', slab: false, extra })), { expectedCrs: 'EPSG:2056', groundStorey: 'EG' });

/** The ground slab 0..20 x 0..10, 0.3 m thick (z -0.3..0), minus `cut` (built in the slab's coordinates). */
const cutSlab = (cut: (b: Extra) => number, roof?: (b: Extra) => void) => (b: Extra) => {
  const slab = b.rectExtrusion(10, 5, 20, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1));
  const body = b.add(`IFCBOOLEANRESULT(.DIFFERENCE.,#${slab},#${cut(b)})`);
  b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Platte geschnitten',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([body])},$,.FLOOR.)`));
  roof?.(b);
};
/** A box 8 x 4 m centred at (10, 5) from z0 to z0 + h. */
const box = (z0: number, h: number, w = 8, d = 4, cx = 10) => (b: Extra) => b.rectExtrusion(cx, 5, w, d, h, b.axis(0, 0, z0), b.dir(0, 0, 1));
const deck = (b: Extra) => {
  const solid = b.rectExtrusion(10, 5, 20, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1));
  b.contain(b.storeys.og.id, b.add(`IFCSLAB(${b.guid()},$,'Decke OG',$,$,#${b.place(b.storeys.og.pl, 0, 0, 0)},#${b.shape([solid])},$,.FLOOR.)`));
};

describe('item 8: a slab hole cut by a Boolean DIFFERENCE is read and classified', () => {
  it('a through cut wholly inside the slab, open above, is a courtyard (not a building-wide voids-filled outline)', async () => {
    const fp = (await extract(cutSlab(box(-1, 2)))).footprint;
    expect(fp.source).toBe('slab-outline');
    expect(fp.courtyardRings).toHaveLength(1);
  });
  it('the same cut under the slab above is interior: the outline is complete', async () => {
    const fp = (await extract(cutSlab(box(-1, 2), deck))).footprint;
    expect(fp.quality?.worst).toBe('complete');
    expect(fp.quality?.notes.join()).toMatch(/wholly roofed/);
  });
  it('a shallow cut (a recess that leaves slab material under it) is no hole even with no roof above it', async () => {
    const fp = (await extract(cutSlab(box(-0.1, 1)))).footprint;
    expect(fp.source).toBe('slab-outline');
    expect(fp.courtyardRings).toBeUndefined();
  });
  it('a cut that crosses the slab\'s edge (a notch) stays voids-filled: its effect on the outline is not read', async () => {
    expect((await extract(cutSlab(box(-1, 2, 8, 4, 18)))).footprint.source).toBe('slab-outline-voids-filled');
  });
  it('a cut by a half space stays voids-filled', async () => {
    const half = (b: Extra) => b.add(`IFCHALFSPACESOLID(#${b.add(`IFCPLANE(#${b.axis(0, 0, -0.1)})`)},.F.)`);
    expect((await extract(cutSlab(half))).footprint.source).toBe('slab-outline-voids-filled');
  });
});

describe('item 5: roofing that is not a slab counts, over the hole\'s whole area', () => {
  /** The ground slab 0..20 x 0..10 with a hole 6..14 x 3..7 in its profile, and `roof` above it. */
  const holedUnder = (roof: (b: Extra) => void) => (b: Extra) => {
    const pt = (x: number, y: number) => b.add(`IFCCARTESIANPOINT((${x}.,${y}.))`);
    const loop = (pts: Array<[number, number]>) => b.add(`IFCPOLYLINE((${[...pts, pts[0]].map(([x, y]) => `#${pt(x, y)}`).join(',')}))`);
    const profile = b.add(`IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#${loop([[0, 0], [20, 0], [20, 10], [0, 10]])},(#${loop([[6, 3], [14, 3], [14, 7], [6, 7]])}))`);
    const solid = b.add(`IFCEXTRUDEDAREASOLID(#${profile},#${b.axis(0, 0, 0)},#${b.dir(0, 0, -1)},0.3)`);
    b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Bodenplatte gelocht',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([solid])},$,.FLOOR.)`));
    roof(b);
  };
  /** An element of `record` (its arguments after the placement and shape) whose body is a flat 0.1 m plate over x0..x1, y 2.5..7.5, 3 m up. */
  const flat = (cls: string, tail: string, x0 = 5, x1 = 15) => (b: Extra) => {
    const plate = b.rectExtrusion((x0 + x1) / 2, 5, x1 - x0, 5, 0.1, b.axis(0, 0, 3), b.dir(0, 0, 1));
    b.contain(b.storeys.eg.id, b.add(`${cls}(${b.guid()},$,'Dach',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([plate])},${tail})`));
  };
  const courtyards = async (roof: (b: Extra) => void) => (await extract(holedUnder(roof))).footprint.courtyardRings?.length ?? 0;

  it('control: with nothing above, the hole is a courtyard', async () => {
    expect(await courtyards(() => {})).toBe(1);
  });
  it('an IfcRoof body over the whole hole roofs it', async () => {
    expect(await courtyards(flat('IFCROOF', '$,.FLAT_ROOF.'))).toBe(0);
  });
  it('an IfcCovering of type ROOFING roofs it; a CEILING covering does not count as roofing', async () => {
    expect(await courtyards(flat('IFCCOVERING', '$,.ROOFING.'))).toBe(0);
    expect(await courtyards(flat('IFCCOVERING', '$,.CEILING.'))).toBe(1);
  });
  it('a skylight (an IfcWindow lying flat over the hole) roofs it', async () => {
    expect(await courtyards(flat('IFCWINDOW', '$,10.,5.,.SKYLIGHT.,$,$'))).toBe(0);
  });
  it('an IfcPlate over only half the hole leaves it open', async () => {
    expect(await courtyards(flat('IFCPLATE', '$,.CURTAIN_PANEL.', 5, 10))).toBe(1);
  });
});

describe('item 20: a partial footprint withholds above-mapped-class-range, by that reason', () => {
  it('a window clearing a shallow class gets above-mapped on a complete footprint, and is withheld (partial-footprint named) on a partial one', async () => {
    const { checkFloodExposure } = await import('../src/check/check.js');
    const { boxFacts, candidate, CODE, CONFIRMED, E0, flatTerrain, N0, NO_OTHER_BUILDINGS, syntheticRaster } = await import('./helpers.js');
    const outside = (p: { x: number; y: number }) => !(p.x > E0 && p.x < E0 + 20 && p.y > N0 && p.y < N0 + 10);
    const ras = syntheticRaster(E0 - 10, N0 - 10, 80, 60, 0.5, (p) => (outside(p) ? CODE['depth-0-0.1'] : 0));
    const doors = [candidate({ expressId: 1, name: 'Fenster', category: 'window', position: { x: E0 + 10, y: N0 }, level: 501.5 }), candidate({ expressId: 2, position: { x: E0 + 5, y: N0 + 10 }, level: 500 })];
    const opts = { renderingConfirmation: CONFIRMED, otherBuildings: NO_OTHER_BUILDINGS };
    const complete = boxFacts(doors);
    expect(checkFloodExposure(complete, ras, flatTerrain(500), opts).results[0].outcome).toBe('above-mapped-class-range');
    const partial = boxFacts(doors, { footprint: { ...complete.footprint, partial: true } });
    const r = checkFloodExposure(partial, ras, flatTerrain(500), opts).results[0];
    expect(r.outcome).toBe('within-class-range');
    expect(r.favourableWithheldBecause.join(' ')).toMatch(/footprint may miss part of the building/);
  });
});

describe('item 15: outline terrain samples, on a slope and for a long outline', () => {
  it('a long outline is sampled in at most 400 points (plus one per side)', async () => {
    const { outlineTerrainPoints, resolveSampling } = await import('../src/check/sampling.js');
    const { prepareFootprint } = await import('../src/region.js');
    const { E0, N0 } = await import('./helpers.js');
    const ring = [{ x: E0, y: N0 }, { x: E0 + 5000, y: N0 }, { x: E0 + 5000, y: N0 + 20 }, { x: E0, y: N0 + 20 }];
    const pts = outlineTerrainPoints(prepareFootprint({ rings: [ring], source: 'given' }), resolveSampling());
    expect(pts.length).toBeLessThanOrEqual(404);
    expect(pts.length).toBeGreaterThan(380);
  });

  it('on a slope the band spans the uphill and the downhill side: a ground storey at the uphill terrain passes, one above it by more than the band is refused', async () => {
    const { checkFloodExposure } = await import('../src/check/check.js');
    const { FloodCheckRefusal } = await import('../src/errors.js');
    const { boxFacts, candidate, CODE, CONFIRMED, E0, flatTerrain, N0, NO_OTHER_BUILDINGS, syntheticRaster } = await import('./helpers.js');
    // A 100 m long building on terrain rising 10 m from west to east; the doors on the east (uphill) end.
    const ring = [{ x: E0, y: N0 }, { x: E0 + 100, y: N0 }, { x: E0 + 100, y: N0 + 20 }, { x: E0, y: N0 + 20 }];
    const slope = { ...flatTerrain(500), heightAt: (p: { x: number }) => 500 + 0.1 * (p.x - E0) };
    const ras = syntheticRaster(E0 - 20, N0 - 20, 280, 120, 0.5, () => CODE['depth-0-0.1']);
    const facts = (g: number) => boxFacts([candidate({ position: { x: E0 + 95, y: N0 }, level: g })], {
      footprint: { rings: [ring], source: 'given', fromElements: [] },
      groundStorey: { expressId: 10, level: g, basis: 'given' },
      storeys: [{ expressId: 10, globalId: 's10', name: 'EG', level: g }],
    });
    const opts = { renderingConfirmation: CONFIRMED, otherBuildings: NO_OTHER_BUILDINGS };
    const ok = checkFloodExposure(facts(509.5), ras, slope, opts).heightPlausibility;
    expect(ok.status).toBe('within-band');
    expect(ok.terrainMin!).toBeLessThan(500.5);
    expect(ok.terrainMax!).toBeGreaterThan(509.5);
    expect(() => checkFloodExposure(facts(514), ras, slope, opts)).toThrow(FloodCheckRefusal);
  });
});

describe('item 4: a clipped body bottom equal to the placement level is still a lower bound', () => {
  it('a light well placed at its clipped body\'s bottom is labelled a lower bound, not exact', async () => {
    const facts = await extract((b) => {
      const first = b.rectExtrusion(0, 0, 1, 1, 1, b.axis(0, 0, 0), b.dir(0, 0, 1)); // z 0..1 in its own frame: bottom at the placement
      const cut = b.rectExtrusion(0, 0, 2, 2, 0.5, b.axis(0, 0, -0.1), b.dir(0, 0, 1)); // may have removed the bottom
      const body = b.add(`IFCBOOLEANRESULT(.DIFFERENCE.,#${first},#${cut})`);
      b.contain(b.storeys.eg.id, b.add(`IFCBUILDINGELEMENTPROXY(${b.guid()},$,'Lichtschacht Ost',$,$,#${b.place(b.storeys.eg.pl, 21, 5, 0)},#${b.shape([body])},$,.ELEMENT.)`));
      b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Platte',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([b.rectExtrusion(10, 5, 20, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1))])},$,.FLOOR.)`));
    });
    expect(facts.candidates.find((c) => c.name === 'Lichtschacht Ost')).toMatchObject({ levelIsLowerBound: true });
  });
});

describe('item 11: with no footprint, outside is unknown', () => {
  it('outsideBy answers null with no rings; the samples are then taken (nothing excludes them) and the footprint withholds', async () => {
    const { outsideBy, prepareFootprint } = await import('../src/region.js');
    const { planSamples, resolveSampling } = await import('../src/check/sampling.js');
    const { candidate, E0, N0 } = await import('./helpers.js');
    const empty = prepareFootprint({ rings: [], source: 'candidate-hull' });
    expect(outsideBy(empty, { x: E0, y: N0 }, 1)).toBeNull();
    expect(planSamples(candidate({ position: { x: E0, y: N0 }, level: 500 }), empty, resolveSampling()).points).toHaveLength(32);
  });
});
