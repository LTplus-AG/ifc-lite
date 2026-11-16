/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Elements that were dropped, or a footprint that silently covered only part
 * of the building (review round on the model extraction).
 */

import { describe, expect, it } from 'vitest';
import { checkFloodExposure } from '../src/check/check.js';
import { extractModelFacts } from '../src/model/extract.js';
import { CELL_NO_RUNOFF, type MapPoint } from '../src/types.js';
import { CODE, CONFIRMED, flatTerrain, syntheticRaster } from './helpers.js';
import { mapOf, ORIGIN, parseStep, ROTATION_DEG, syntheticHouse, type Extra } from './synthetic-model.js';

const extract = async (extra: (b: Extra) => void) =>
  extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', extra })), { expectedCrs: 'EPSG:2056', groundStorey: 'EG' });

function localOf(p: MapPoint): MapPoint {
  const a = (ROTATION_DEG * Math.PI) / 180;
  const dx = p.x - ORIGIN.e;
  const dy = p.y - ORIGIN.n;
  return { x: dx * Math.cos(a) + dy * Math.sin(a), y: -dx * Math.sin(a) + dy * Math.cos(a) };
}

describe('a ground storey with a second floor slab whose outline cannot be read', () => {
  // The real building is 40 m x 10 m: the house slab (0..20) plus an extension slab (20..40) given as a Brep.
  const extension = (b: Extra) => {
    const slab = b.add(`IFCSLAB(${b.guid()},$,'Bodenplatte Anbau',$,$,#${b.place(b.storeys.eg.pl, 20, 0, 0)},#${b.shape([b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`)], 'Body', 'Brep')},$,.FLOOR.)`);
    b.contain(b.storeys.eg.id, slab);
    b.contain(b.storeys.ug.id, b.add(`IFCBOILER(${b.guid()},$,'Kessel Anbau',$,$,#${b.place(b.storeys.ug.pl, 30, 5, 0)},$,$,.WATER.)`));
  };
  const deep = CODE['depth-gt-0.25'];
  /** Deep class in a 4 m band round the real 40 m x 10 m building; the building itself raised (transparent). */
  const paint = (p: MapPoint) => {
    const l = localOf(p);
    const inside = l.x >= 0 && l.x <= 40 && l.y >= 0 && l.y <= 10;
    return !inside && l.x > -4 && l.x < 44 && l.y > -4 && l.y < 14 ? deep : CELL_NO_RUNOFF;
  };

  it('the footprint is marked partial, the skip is recorded and no element gets a reassuring outcome', async () => {
    const facts = await extract(extension);
    expect(facts.footprint).toMatchObject({ source: 'slab-outline', partial: true });
    expect(facts.skipped.find((s) => s.ifcClass === 'IfcSlab' && /outline/.test(s.reason))).toBeDefined();
    expect(facts.warnings.join()).toMatch(/footprint covers only part of the ground storey/);
    const corners = [mapOf(-10, -10), mapOf(50, -10), mapOf(-10, 20), mapOf(50, 20)];
    const x0 = Math.floor(Math.min(...corners.map((p) => p.x)));
    const y0 = Math.floor(Math.min(...corners.map((p) => p.y)));
    const raster = syntheticRaster(x0, y0, 140, 120, 0.5, paint);
    const r = checkFloodExposure(facts, raster, flatTerrain(499.95), { renderingConfirmation: CONFIRMED });
    const boiler = r.results.find((x) => x.candidate.name === 'Kessel Anbau')!;
    expect(boiler).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'partial-footprint' });
    for (const x of r.results) expect(['no-runoff-mapped', 'above-mapped-class-range']).not.toContain(x.outcome);
  });
});

