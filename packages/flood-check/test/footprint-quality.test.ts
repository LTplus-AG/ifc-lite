/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Footprint quality is one record that only accumulates through the chain of
 * footprint sources (`footprint.ts`): a fallback may supply geometry, never
 * upgrade the quality or drop what could not be read.
 */

import { describe, expect, it } from 'vitest';
import { extractModelFacts } from '../src/model/extract.js';
import { footprintConcerns, type FootprintQuality } from '../src/model/facts.js';
import { footprintDoubt, groundDoubt, scopeExclusion, type CandidateContext } from '../src/model/candidate-base.js';
import { mapOf } from './synthetic-model.js';
import { parseStep, syntheticHouse, type Extra } from './synthetic-model.js';

/** External walls with axes along a chain of local points (one wall per segment), in the ground storey. */
function wallLoop(b: Extra, pts: Array<[number, number]>) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const axis = b.add(`IFCPOLYLINE((#${b.pt2(ax, ay)},#${b.pt2(bx, by)}))`);
    const wall = b.add(`IFCWALL(${b.guid()},$,'Wand ${i}',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([axis], 'Axis', 'Curve2D')},$,.STANDARD.)`);
    b.pset(wall, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
    b.contain(b.storeys.eg.id, wall);
  }
}

type Slabs = 'given' | 'slab readable' | 'slab with voids' | 'slab partly readable' | 'slab unreadable' | 'no slab';
type Walls = 'walls full loop' | 'walls partial loop' | 'no walls';

/** A ground-storey slab over local 0..20 x 0..10, readable (an extrusion) or not (a Brep). */
function slab(b: Extra, readable: boolean, x0 = 0, voids = false) {
  let body: number;
  if (readable && !voids) {
    body = b.rectExtrusion(10, 5, 20, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1));
  } else if (readable) {
    const outer = b.add(`IFCPOLYLINE((#${b.pt2(0, 0)},#${b.pt2(20, 0)},#${b.pt2(20, 10)},#${b.pt2(0, 10)},#${b.pt2(0, 0)}))`);
    const inner = b.add(`IFCPOLYLINE((#${b.pt2(8, 3)},#${b.pt2(12, 3)},#${b.pt2(12, 7)},#${b.pt2(8, 7)},#${b.pt2(8, 3)}))`);
    const profile = b.add(`IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#${outer},(#${inner}))`);
    body = b.add(`IFCEXTRUDEDAREASOLID(#${profile},#${b.axis(0, 0, 0)},#${b.dir(0, 0, -1)},0.3)`);
  } else {
    body = b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`);
  }
  const s = b.add(`IFCSLAB(${b.guid()},$,'Platte',$,$,#${b.place(b.storeys.eg.pl, x0, 0, 0)},#${b.shape([body])},$,.FLOOR.)`);
  b.contain(b.storeys.eg.id, s);
}

/** The house's own south wall (0..20 at y = 0) is always there; a full loop adds east, north and west, a partial loop leaves out the west. */
function walls(b: Extra, w: Walls) {
  if (w === 'walls full loop') wallLoop(b, [[20, 0], [20, 10], [0, 10], [0, 0]]);
  if (w === 'walls partial loop') wallLoop(b, [[20, 0], [20, 10], [0, 10]]);
}

async function chain(slabs: Slabs, w: Walls) {
  const extra = (b: Extra) => {
    if (slabs === 'slab readable') slab(b, true);
    if (slabs === 'slab with voids') slab(b, true, 0, true);
    if (slabs === 'slab partly readable') { slab(b, true); slab(b, false, 20); }
    if (slabs === 'slab unreadable') slab(b, false);
    walls(b, w);
  };
  const given = slabs === 'given' ? { footprint: [[mapOf(0, 0), mapOf(20, 0), mapOf(20, 10), mapOf(0, 10)]] } : {};
  return extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', slab: false, extra })), { expectedCrs: 'EPSG:2056', ...given });
}

/** The expected worst quality of a chain. */
function expected(slabs: Slabs, w: Walls): FootprintQuality {
  if (slabs === 'given' || slabs === 'slab readable') return 'complete';
  // The synthetic house has no slab above, so the profile's hole is open to the sky: a courtyard (guarded locally), never complete.
  if (slabs === 'slab with voids') return 'courtyard-ring';
  if (slabs === 'slab partly readable') return 'partial';
  if (w !== 'walls full loop') return 'hull';
  return slabs === 'slab unreadable' ? 'partial' : 'complete';
}

describe('footprint source chains', () => {
  const rows: Array<[Slabs, Walls]> = [];
  for (const slabs of ['given', 'slab readable', 'slab with voids', 'slab partly readable', 'slab unreadable', 'no slab'] as const) {
    for (const w of ['walls full loop', 'walls partial loop', 'no walls'] as const) rows.push([slabs, w]);
  }

  it.each(rows)('%s, %s', async (slabs, w) => {
    const facts = await chain(slabs, w);
    const worst = footprintConcerns(facts.footprint).worst;
    expect(worst).toBe(expected(slabs, w));
    expect(facts.footprint.quality?.worst).toBe(worst);
    // A chain with an unreadable or partly readable source never ends complete, and keeps the list of what could not be read.
    if (slabs === 'slab partly readable' || slabs === 'slab unreadable') {
      expect(worst).not.toBe('complete');
      expect(facts.footprint.quality?.unreadable.map((u) => u.ifcClass)).toContain('IfcSlab');
      expect(facts.footprint.partial).toBe(true);
    }
  });

  it('the quality record cannot be changed after the fact', async () => {
    const q = (await chain('slab unreadable', 'walls full loop')).footprint.quality!;
    expect(Object.isFrozen(q) && Object.isFrozen(q.conditions) && Object.isFrozen(q.unreadable)).toBe(true);
  });

});

describe('decisions that rest on an uncertain ground storey or footprint keep the element', () => {
  const ctx = (over: Partial<CandidateContext>) => ({
    storeyOf: () => 2,
    storeyLevel: new Map([[2, 504]]),
    groundLevel: 500,
    aboveGroundScope: 3,
    ...over,
  }) as unknown as CandidateContext;

  it('out of scope only when the ground storey is known', () => {
    expect(scopeExclusion(ctx({}), 505)).toMatch(/out of scope/);
    expect(scopeExclusion(ctx({ groundUncertain: true }), 505)).toBeNull();
    expect(scopeExclusion(ctx({}), null)).toBeNull(); // no proven lower bound: kept
    expect(groundDoubt(ctx({ groundUncertain: true }))).toMatch(/guessed/);
  });

  it('inside a hull or a voids-filled footprint proves nothing; outside a partial one neither', () => {
    expect(footprintDoubt(ctx({ footprintQuality: { hullLike: true, partial: false } }), -5)).toMatch(/fills courtyards/);
    expect(footprintDoubt(ctx({ footprintQuality: { hullLike: false, partial: true } }), 5)).toMatch(/partial/);
    expect(footprintDoubt(ctx({ footprintQuality: { hullLike: false, partial: true } }), -5)).toBeNull();
    expect(footprintDoubt(ctx({ footprintQuality: { hullLike: false, partial: false } }), -5)).toBeNull();
  });

  it('a door with no IsExternal on a slab whose profile hole is open to the sky, far from its outer outline (a courtyard façade), is kept', async () => {
    const facts = extractModelFacts(await parseStep(syntheticHouse({
      verticalDatum: 'LN02',
      slab: false,
      extra: (b) => {
        slab(b, true, 0, true);
        b.contain(b.storeys.eg.id, b.add(`IFCDOOR(${b.guid()},$,'Hoftür',$,$,#${b.place(b.storeys.eg.pl, 10, 3, 0)},$,$,2.1,1.,.DOOR.,$,$)`));
      },
    })), { expectedCrs: 'EPSG:2056' });
    // The hole is a courtyard (open ground, `courtyard-ring`), so the door faces its outline and is kept as façade.
    expect(footprintConcerns(facts.footprint).worst).toBe('courtyard-ring');
    expect(facts.candidates.find((c) => c.name === 'Hoftür')?.selectedBecause).toMatch(/within 1 m of the footprint outline/);
  });
});

describe('an uncertain location does not exclude (review round on head ecc53bf3)', () => {
  it('a window whose filled opening reads only 2.5 m inside the façade, beside an unreadable part, is kept', async () => {
    const facts = extractModelFacts(await parseStep(syntheticHouse({
      verticalDatum: 'LN02',
      extra: (b) => {
        // The opening's readable part is centred 2.5 m inside the east face (x = 17.5); an unreadable Brep may reach x = 20.
        const part = b.rectExtrusion(0, 0, 1, 1, 0.4, b.axis(17.3, 5, 1, b.dir(1, 0, 0), b.dir(0, 1, 0)), b.dir(0, 0, 1));
        const brep = b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`);
        const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung teils',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([part, brep])},$,.OPENING.)`);
        const win = b.add(`IFCWINDOW(${b.guid()},$,'Fenster teils',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},$,$,1.,1.,.WINDOW.,$,$)`);
        b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${opening},#${win})`);
        b.contain(b.storeys.eg.id, win);
      },
    })), { expectedCrs: 'EPSG:2056' });
    expect(facts.candidates.find((c) => c.name === 'Fenster teils')).toMatchObject({ levelIsUpperEstimate: true });
  });

  it('equipment with no storey whose readable part is above the scope, beside an unreadable part, is kept', async () => {
    const facts = extractModelFacts(await parseStep(syntheticHouse({
      verticalDatum: 'LN02',
      extra: (b) => {
        const part = b.rectExtrusion(0, 0, 1, 1, 1, b.axis(0, 0, -1), b.dir(0, 0, 1)); // 504..505 m
        const brep = b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`);
        // Not contained in any storey: the storey cannot be resolved.
        b.add(`IFCPUMP(${b.guid()},$,'Pumpe ohne Geschoss',$,$,#${b.place(b.storeys.eg.pl, 10, 5, 5)},#${b.shape([part, brep])},$,.CIRCULATOR.)`);
      },
    })), { expectedCrs: 'EPSG:2056' });
    expect(facts.candidates.find((c) => c.name === 'Pumpe ohne Geschoss')).toMatchObject({ levelIsUpperEstimate: true });
  });
});
