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
import { CELL_NO_RUNOFF, type MapPoint } from '../src/types.js';
import { CODE, CONFIRMED, flatTerrain } from './helpers.js';
import { raster, secondBuilding, zooForFixtures } from './candidate-fixtures.js';
import { equipment2x3 } from './synthetic-2x3.js';
import { parseStep, syntheticHouse, type Extra } from './synthetic-model.js';

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
