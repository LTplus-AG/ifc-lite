/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Out of scope" needs a proven lower bound for the element (`locate`'s
 * `lowest`), never its storey as a stand-in (review round on head 101c83ab).
 */

import { describe, expect, it } from 'vitest';
import { extractModelFacts } from '../src/model/extract.js';
import { locate, NO_BODY, type MapBody } from '../src/model/locate.js';
import { parseStep, syntheticHouse, type Extra } from './synthetic-model.js';

/** A window on the upper storey (+4 m), its filled opening's body readable (z 4..5) or an unreadable Brep; OverallHeight as given. */
function upperWindow(readable: boolean, overallHeight: number | null) {
  return (b: Extra) => {
    const wall = b.add(`IFCWALL(${b.guid()},$,'Wand Ost',$,$,#${b.place(b.storeys.eg.pl, 20, 0, 0)},$,$,.STANDARD.)`);
    b.pset(wall, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
    const body = readable
      ? b.rectExtrusion(0, 0, 1, 1, 0.4, b.axis(-0.2, 5, 4.5, b.dir(1, 0, 0), b.dir(0, 1, 0)), b.dir(0, 0, 1))
      : b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`);
    const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung OG',$,$,#${b.place(b.storeys.eg.pl, 20, 0, 0)},#${b.shape([body])},$,.OPENING.)`);
    b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${opening})`);
    const h = overallHeight === null ? '$' : String(overallHeight).includes('.') ? String(overallHeight) : `${overallHeight}.`;
    const win = b.add(`IFCWINDOW(${b.guid()},$,'Fenster OG',$,$,#${b.place(b.storeys.og.pl, 20, 5, 0)},$,$,${h},1.,.WINDOW.,$,$)`);
    b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${opening},#${win})`);
    b.contain(b.storeys.eg.id, wall);
    b.contain(b.storeys.og.id, win);
  };
}

const extract = async (extra: (b: Extra) => void) =>
  extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', extra })), { expectedCrs: 'EPSG:2056', groundStorey: 'EG' });

describe('the reported case', () => {
  it('an upper-storey window whose filled opening cannot be read, with no OverallHeight, is kept (its storey proves no height)', async () => {
    const facts = await extract(upperWindow(false, null));
    expect(facts.candidates.find((c) => c.name === 'Fenster OG')).toMatchObject({ levelIsUpperEstimate: true });
  });
});

describe('the scope rule over {storey above ground} × {body readable / unreadable} × {OverallHeight present / absent}', () => {
  // Ground storey at 500 m, scope up to 503 m; the window is placed at 504 m on the upper storey.
  const rows: Array<[string, boolean, number | null, 'excluded' | 'kept']> = [
    ['readable hole, OverallHeight 1 m', true, 1, 'excluded'], // exact at 504 m: proven above 503 m
    ['readable hole, no OverallHeight', true, null, 'excluded'], // exact at 504 m
    ['unreadable hole, OverallHeight 0.5 m', false, 0.5, 'excluded'], // proven lowest 503.5 m
    ['unreadable hole, OverallHeight 3.8 m', false, 3.8, 'kept'], // may reach 500.2 m
    ['unreadable hole, no OverallHeight', false, null, 'kept'], // no proven bound
  ];
  it.each(rows)('%s → %s', async (_label, readable, h, verdict) => {
    const facts = await extract(upperWindow(readable, h));
    const kept = facts.candidates.some((c) => c.name === 'Fenster OG');
    expect(kept ? 'kept' : 'excluded').toBe(verdict);
    if (!kept) expect(facts.skipped.find((s) => s.ifcClass === 'IfcWindow' && /out of scope/.test(s.reason))?.reason).toMatch(/lowest possible level/);
  });
});

describe('locate returns the lowest possible level with the level', () => {
  const body = (items: number, readable: number, bottom: number): MapBody => ({
    items,
    readable,
    corners: readable > 0 ? [[0, 0, bottom], [1, 0, bottom], [1, 1, bottom + 1], [0, 1, bottom + 1]] : [],
  });
  const at = { position: { x: 0.5, y: 0.5 }, level: 504 };
  it('exact: the level itself; upper estimate: placement minus OverallHeight, or no bound', () => {
    expect(locate('window', { placement: at, own: { ...NO_BODY }, filled: body(1, 1, 504) })).toMatchObject({ quality: 'exact', lowest: 504 });
    expect(locate('window', { placement: at, own: { ...NO_BODY }, filled: body(1, 0, 0), overallHeight: 3.8 })).toMatchObject({ quality: 'upper-estimate' });
    expect((locate('window', { placement: at, own: { ...NO_BODY }, filled: body(1, 0, 0), overallHeight: 3.8 }) as { lowest: number }).lowest).toBeCloseTo(500.2, 6);
    expect(locate('window', { placement: at, own: { ...NO_BODY }, filled: body(1, 0, 0) })).toMatchObject({ quality: 'upper-estimate', lowest: null });
    // An opening is bounded only by its own readable body, never by its filling's height (audit finding 8: it may be taller).
    expect(locate('opening', { placement: at, own: body(1, 0, 0) })).toMatchObject({ quality: 'upper-estimate', lowest: null });
    expect(locate('light-well', { placement: at, own: body(2, 1, 503) })).toMatchObject({ quality: 'upper-estimate', lowest: null });
    expect(locate('equipment', { placement: at, own: { ...NO_BODY } })).toMatchObject({ quality: 'upper-estimate', lowest: null });
    expect(locate('equipment', { placement: at, own: body(1, 1, 504) })).toMatchObject({ quality: 'exact', lowest: 504 });
  });
});

describe('RULE: a door or window placement alone never yields an exact level (review round on head e4f49ac7)', () => {
  it('the reported case: a window placed at its head 3.5 m up, OverallHeight 1 m, no body, no opening, is kept with its sill as the bound', async () => {
    const facts = await extract((b) => {
      const win = b.add(`IFCWINDOW(${b.guid()},$,'Fenster Kopf',$,$,#${b.place(b.storeys.eg.pl, 20, 5, 3.5)},$,$,1.,1.,.WINDOW.,$,$)`);
      b.pset(win, 'Pset_WindowCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
      b.contain(b.storeys.eg.id, win);
    });
    expect(facts.candidates.find((c) => c.name === 'Fenster Kopf')).toMatchObject({ levelIsUpperEstimate: true });
  });

  it('for doors and windows, no body and no (or no readable) filled opening gives an upper estimate for every OverallHeight state', () => {
    const at = { position: { x: 0.5, y: 0.5 }, level: 503.5 };
    for (const kind of ['door', 'window'] as const) {
      for (const filled of [null, { ...NO_BODY }]) {
        for (const overallHeight of [undefined, null, 1, 3.8]) {
          const loc = locate(kind, { placement: at, own: { ...NO_BODY }, filled, overallHeight });
          expect(loc, `${kind}, filled ${filled ? 'without body' : 'none'}, OverallHeight ${overallHeight}`).toMatchObject({
            quality: 'upper-estimate',
            positionCertain: false,
            lowest: typeof overallHeight === 'number' ? 503.5 - overallHeight : null,
          });
        }
      }
    }
  });
});
