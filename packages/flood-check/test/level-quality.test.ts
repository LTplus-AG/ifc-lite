/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The quality of a candidate's level and position (`locate.ts`) over the whole
 * readability matrix, the earlier instances pinned as rows of the same table,
 * and end to end: an upper-estimate level never yields a reassuring outcome.
 */

import { describe, expect, it } from 'vitest';
import { checkFloodExposure } from '../src/check/check.js';
import { extractModelFacts } from '../src/model/extract.js';
import { locate, NO_BODY, type LocateKind, type LocationSources, type MapBody } from '../src/model/locate.js';
import { CELL_NO_RUNOFF, type MapPoint } from '../src/types.js';
import { CODE, CONFIRMED, flatTerrain } from './helpers.js';
import { raster, secondBuilding, zooForFixtures } from './candidate-fixtures.js';
import { equipment2x3 } from './synthetic-2x3.js';
import { parseStep, syntheticHouse, type Extra } from './synthetic-model.js';

type Body = 'none' | 'readable' | 'partly readable' | 'wholly unreadable';
const BODIES: Body[] = ['none', 'readable', 'partly readable', 'wholly unreadable'];

/** A body over x 0..1, y 0..1, z from `bottom` to `bottom + 2`. */
function body(state: Body, bottom = 500, x = 0): MapBody {
  const corners: Array<[number, number, number]> = [
    [x, 0, bottom], [x + 1, 0, bottom], [x + 1, 1, bottom], [x, 1, bottom],
    [x, 0, bottom + 2], [x + 1, 0, bottom + 2], [x + 1, 1, bottom + 2], [x, 1, bottom + 2],
  ];
  switch (state) {
    case 'none': return { ...NO_BODY };
    case 'readable': return { items: 1, readable: 1, corners };
    case 'partly readable': return { items: 2, readable: 1, corners };
    case 'wholly unreadable': return { items: 1, readable: 0, corners: [] };
  }
}

const placement = (level = 501, position: MapPoint = { x: 0.5, y: 0.5 }) => ({ position, level });

/** The quality the specification gives (README, `locate.ts`). */
function expected(kind: LocateKind, placed: boolean, own: Body, filled: Body | 'n/a'): 'refused' | 'exact' | 'upper-estimate' {
  if (!placed) return 'refused';
  if (kind === 'stair' || kind === 'ramp') return 'upper-estimate';
  const unreadable = (b: Body | 'n/a') => b === 'partly readable' || b === 'wholly unreadable';
  if (unreadable(own) || unreadable(filled)) return 'upper-estimate';
  if ((kind === 'opening' || kind === 'slab-opening' || kind === 'light-well') && own === 'none') return 'upper-estimate';
  return 'exact';
}

describe('the readability matrix', () => {
  const kinds: LocateKind[] = ['door', 'window', 'opening', 'slab-opening', 'light-well', 'stair', 'ramp', 'equipment'];
  const rows: Array<[LocateKind, boolean, Body, Body | 'n/a']> = [];
  for (const kind of kinds) {
    const filledStates: Array<Body | 'n/a'> = kind === 'door' || kind === 'window' ? ['n/a', 'readable', 'partly readable', 'wholly unreadable'] : ['n/a'];
    for (const placed of [true, false]) for (const own of BODIES) for (const filled of filledStates) rows.push([kind, placed, own, filled]);
  }

  it.each(rows)('%s, placement %s, own body %s, filled opening %s', (kind, placed, own, filled) => {
    const s: LocationSources = {
      placement: placed ? placement() : null,
      own: body(own),
      filled: filled === 'n/a' ? null : body(filled, 499.5),
      hostLevel: kind === 'slab-opening' ? 500 : undefined,
      groundLevel: 500,
    };
    const loc = locate(kind, s);
    const quality = 'refused' in loc ? 'refused' : loc.quality;
    expect(quality).toBe(expected(kind, placed, own, filled));
    // Nothing unreadable ever yields `exact`.
    if (own === 'partly readable' || own === 'wholly unreadable' || filled === 'partly readable' || filled === 'wholly unreadable') {
      expect(quality).not.toBe('exact');
    }
    if (quality === 'upper-estimate' && !('refused' in loc) && kind !== 'stair' && kind !== 'ramp') {
      expect(loc.notes.join()).toMatch(/upper estimate/);
    }
  });

  it('covers every class and every combination', () => {
    expect(rows).toHaveLength(2 * (2 * 4 * 4) + 6 * (2 * 4));
  });
});

describe('the earlier instances, as rows of the same table', () => {
  it('the reviewer\'s case: a window placed at its 502 m head filling an opening whose only body is an unreadable Brep', () => {
    const loc = locate('window', { placement: placement(502), own: body('none'), filled: body('wholly unreadable') });
    expect(loc).toMatchObject({ level: 502, quality: 'upper-estimate' });
  });

  it('a window placed at its head: the readable hole\'s bottom is used, exactly', () => {
    const loc = locate('window', { placement: placement(502), own: body('none'), filled: body('readable', 500) });
    expect(loc).toMatchObject({ level: 500, basis: 'opening-body-bottom', quality: 'exact' });
  });

  it('a light well placed at 502 m whose body reaches 499 m: the body\'s bottom, exactly', () => {
    const loc = locate('light-well', { placement: placement(502), own: body('readable', 499) });
    expect(loc).toMatchObject({ level: 499, basis: 'opening-body-bottom', quality: 'exact' });
  });

  it('a partly readable opening, alone or filled: an upper estimate', () => {
    expect(locate('opening', { placement: placement(500), own: body('partly readable', 502) })).toMatchObject({ level: 502, quality: 'upper-estimate' });
    expect(locate('window', { placement: placement(502), own: body('none'), filled: body('partly readable', 502) })).toMatchObject({ quality: 'upper-estimate' });
  });

  it('a door placed at its wall origin: at the hole it fills, 15 m along', () => {
    const loc = locate('door', { placement: placement(500, { x: 0, y: 0 }), own: body('none'), filled: body('readable', 500, 14.5) });
    expect(loc).toMatchObject({ quality: 'exact' });
    expect('refused' in loc ? null : loc.position.x).toBeCloseTo(15, 6);
    expect('refused' in loc ? '' : loc.notes.join()).toMatch(/hole it fills/);
  });

  it('a placement-only door (its placement is its threshold by the schema) stays exact; a placement-only opening does not', () => {
    expect(locate('door', { placement: placement(500), own: body('none'), filled: null })).toMatchObject({ quality: 'exact' });
    expect(locate('door', { placement: placement(500), own: body('none'), filled: body('none') })).toMatchObject({ quality: 'exact' });
    expect(locate('opening', { placement: placement(500), own: body('none') })).toMatchObject({ quality: 'upper-estimate' });
  });
});

/** The reviewer's case in a model: placements at the 502 m head, the filled opening only an unreadable Brep from 500 to 502 m. */
function windowOverUnreadableHole(b: Extra) {
  const wall = b.add(`IFCWALL(${b.guid()},$,'Wand Ost',$,$,#${b.place(b.storeys.eg.pl, 20, 0, 0)},$,$,.STANDARD.)`);
  b.pset(wall, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
  const brep = b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`);
  const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung nur Brep',$,$,#${b.place(b.storeys.eg.pl, 20, 5, 2)},#${b.shape([brep], 'Body', 'Brep')},$,.OPENING.)`);
  b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${opening})`);
  const win = b.add(`IFCWINDOW(${b.guid()},$,'Fenster über Brep',$,$,#${b.place(b.storeys.eg.pl, 20, 5, 2)},$,$,2.,1.,.WINDOW.,$,$)`);
  b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${opening},#${win})`);
  b.contain(b.storeys.eg.id, wall);
  b.contain(b.storeys.eg.id, win);
}

describe('end to end', () => {
  it('the reviewer\'s case: the window is an upper estimate and a shallow class does not clear it', async () => {
    const facts = extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', extra: windowOverUnreadableHole })), { expectedCrs: 'EPSG:2056' });
    const win = facts.candidates.find((c) => c.name === 'Fenster über Brep')!;
    expect(win).toMatchObject({ level: 502, levelIsUpperEstimate: true });
    const r = checkFloodExposure(facts, raster(() => CODE['depth-0-0.1']), flatTerrain(499.95), { renderingConfirmation: CONFIRMED });
    expect(r.results.find((x) => x.candidate.name === 'Fenster über Brep')!.outcome).not.toBe('above-mapped-class-range');
  });

  const fixtures: Array<[string, () => string]> = [
    ['the house', () => syntheticHouse({ verticalDatum: 'LN02' })],
    ['the house with every exit', () => syntheticHouse({ verticalDatum: 'LN02', extra: zooForFixtures })],
    ['the house with the reviewer\'s window', () => syntheticHouse({ verticalDatum: 'LN02', extra: windowOverUnreadableHole })],
    ['two buildings', () => syntheticHouse({ verticalDatum: 'LN02', extra: secondBuilding })],
    ['IFC2X3 equipment', () => equipment2x3()],
  ];
  const paints: Array<[string, (l: MapPoint) => number]> = [
    ['nothing mapped', () => CELL_NO_RUNOFF],
    ['a shallow class everywhere', () => CODE['depth-0-0.1']],
    ['a deep class south of the house', (l) => (l.y < 0 ? CODE['depth-gt-0.25'] : CELL_NO_RUNOFF)],
  ];
  for (const [label, text] of fixtures) {
    it(`${label}: no upper-estimate level gets a reassuring outcome`, async () => {
      const facts = extractModelFacts(await parseStep(text()), { expectedCrs: 'EPSG:2056' });
      for (const [, paint] of paints) {
        const r = checkFloodExposure(facts, raster(paint), flatTerrain(499.95), { renderingConfirmation: CONFIRMED });
        for (const x of r.results) {
          if (x.candidate.levelIsUpperEstimate) expect(['above-mapped-class-range', 'no-runoff-mapped'], `${x.candidate.name}`).not.toContain(x.outcome);
        }
      }
    });
  }
});
