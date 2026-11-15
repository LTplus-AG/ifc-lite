/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Candidate selection leaves no third way out: every element of a class the
 * check covers is a candidate or in `skipped` with a reason, and an exclusion
 * that would rest on unreadable or unusually placed data keeps the element.
 */

import { describe, expect, it } from 'vitest';
import { checkFloodExposure } from '../src/check/check.js';
import { extractModelFacts } from '../src/model/extract.js';
import { EQUIPMENT_OCCURRENCES } from '../src/model/equipment.js';
import { LIGHT_WELL_NAME } from '../src/model/candidates.js';
import { ModelReader, asString } from '../src/model/reader.js';
import { CELL_NO_RUNOFF, type MapPoint } from '../src/types.js';
import { CODE, CONFIRMED, flatTerrain, syntheticRaster } from './helpers.js';
import { mapOf, ORIGIN, parseStep, ROTATION_DEG, syntheticHouse, type Extra } from './synthetic-model.js';

function localOf(p: MapPoint): MapPoint {
  const a = (ROTATION_DEG * Math.PI) / 180;
  const dx = p.x - ORIGIN.e;
  const dy = p.y - ORIGIN.n;
  return { x: dx * Math.cos(a) + dy * Math.sin(a), y: -dx * Math.sin(a) + dy * Math.cos(a) };
}

function raster(paint: (local: MapPoint) => number) {
  const c = [mapOf(-10, -10), mapOf(40, -10), mapOf(-10, 25), mapOf(40, 25)];
  const x0 = Math.floor(Math.min(...c.map((p) => p.x)));
  const y0 = Math.floor(Math.min(...c.map((p) => p.y)));
  return syntheticRaster(x0, y0, 120, 120, 0.5, (p) => paint(localOf(p)));
}

/** An external wall along the east face (x = 20) of the house. */
function eastWall(b: Extra): number {
  const wall = b.add(`IFCWALL(${b.guid()},$,'Wand Ost',$,$,#${b.place(b.storeys.eg.pl, 20, 0, 0)},$,$,.STANDARD.)`);
  b.pset(wall, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
  b.contain(b.storeys.eg.id, wall);
  return wall;
}

/** A door placed at the south wall's origin while its opening's body puts the hole 15 m along the façade. */
function doorAtWallOrigin(b: Extra) {
  const wall = b.add(`IFCWALL(${b.guid()},$,'Wand Süd 2',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},$,$,.STANDARD.)`);
  b.pset(wall, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
  const hole = b.rectExtrusion(0, 0, 1, 2.1, 0.4, b.axis(15, -0.2, 1.05, b.dir(0, 1, 0), b.dir(1, 0, 0)), b.dir(0, 0, 1));
  const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung Tor',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([hole])},$,.OPENING.)`);
  b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${opening})`);
  const door = b.add(`IFCDOOR(${b.guid()},$,'Tor',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},$,$,2.1,1.,.DOOR.,$,$)`);
  b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${opening},#${door})`);
  b.contain(b.storeys.eg.id, wall);
  b.contain(b.storeys.eg.id, door);
}

/** A window in the east wall whose opening has a readable upper part (z 2..3) and an unreadable lower item. */
function windowWithPartlyReadableOpening(b: Extra) {
  const wall = eastWall(b);
  const upper = b.rectExtrusion(0, 0, 1, 1, 0.4, b.axis(-0.2, 5, 2.5, b.dir(1, 0, 0), b.dir(0, 1, 0)), b.dir(0, 0, 1));
  const lower = b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`);
  const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung Fenster Brep',$,$,#${b.place(b.storeys.eg.pl, 20, 0, 0)},#${b.shape([upper, lower])},$,.OPENING.)`);
  b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${opening})`);
  const win = b.add(`IFCWINDOW(${b.guid()},$,'Fenster Brep',$,$,#${b.place(b.storeys.eg.pl, 20, 5, 2.5)},$,$,1.,1.,.WINDOW.,$,$)`);
  b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${opening},#${win})`);
  b.contain(b.storeys.eg.id, win);
}

/** A ramp placed 0.5 m inside the east face, no IsExternal, its body descending outside (x 20.5..23.5, z -1.5..0). */
function rampPlacedInside(b: Extra) {
  const body = b.rectExtrusion(3.5, 0, 3, 2, 1.5, b.axis(0, 0, -1.5), b.dir(0, 0, 1));
  const ramp = b.add(`IFCRAMP(${b.guid()},$,'Rampe Garage',$,$,#${b.place(b.storeys.eg.pl, 19.5, 5, 0)},#${b.shape([body])},$,.STRAIGHT_RUN_RAMP.)`);
  b.contain(b.storeys.eg.id, ramp);
}

const extract = async (extra: (b: Extra) => void) =>
  extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', extra })), { expectedCrs: 'EPSG:2056' });
const deep = CODE['depth-gt-0.25'];
const shallow = CODE['depth-0-0.1'];

describe('the three reported cases', () => {
  it('a door placed at its wall origin is sampled at its opening, 15 m along the façade', async () => {
    const facts = await extract(doorAtWallOrigin);
    const door = facts.candidates.find((c) => c.name === 'Tor')!;
    const at = localOf(door.position);
    expect(at.x).toBeCloseTo(15, 1);
    // Deep class only in front of the real entrance: the door is exposed, not "no runoff mapped" at the wall origin.
    const r = checkFloodExposure(facts, raster((l) => (l.y < 0 && l.x > 12 && l.x < 18 ? deep : CELL_NO_RUNOFF)), flatTerrain(499.95), { renderingConfirmation: CONFIRMED });
    expect(r.results.find((x) => x.candidate.name === 'Tor')!.outcome).toBe('exposed');
  });

  it('a window whose opening body is only partly readable gets an upper-estimate level and no favourable outcome', async () => {
    const facts = await extract(windowWithPartlyReadableOpening);
    const win = facts.candidates.find((c) => c.name === 'Fenster Brep')!;
    expect(win.levelIsUpperEstimate).toBe(true);
    const r = checkFloodExposure(facts, raster(() => shallow), flatTerrain(499.95), { renderingConfirmation: CONFIRMED });
    expect(r.results.find((x) => x.candidate.name === 'Fenster Brep')!.outcome).not.toBe('above-mapped-class-range');
  });

  it('a ramp placed just inside the footprint whose body descends outside it is kept', async () => {
    const facts = await extract(rampPlacedInside);
    expect(facts.candidates.map((c) => c.name)).toContain('Rampe Garage');
  });
});

describe('every element of a covered class is a candidate or skipped, exactly once', () => {
  /** Extra elements that each take a different exit of candidate selection. */
  const zoo = (b: Extra) => {
    doorAtWallOrigin(b);
    windowWithPartlyReadableOpening(b);
    rampPlacedInside(b);
    const { eg, og, ug } = b.storeys;
    // Interior door, no pset, deep inside; and one explicitly not external.
    b.contain(eg.id, b.add(`IFCDOOR(${b.guid()},$,'Innentür',$,$,#${b.place(eg.pl, 10, 5, 0)},$,$,2.1,1.,.DOOR.,$,$)`));
    const notExt = b.add(`IFCDOOR(${b.guid()},$,'Zimmertür',$,$,#${b.place(eg.pl, 8, 5, 0)},$,$,2.1,1.,.DOOR.,$,$)`);
    b.pset(notExt, 'Pset_DoorCommon', 'IsExternal', 'IFCBOOLEAN(.F.)');
    b.contain(eg.id, notExt);
    // A door with no placement.
    b.contain(eg.id, b.add(`IFCDOOR(${b.guid()},$,'Tür ohne Platz',$,$,$,$,$,2.1,1.,.DOOR.,$,$)`));
    // An upper-floor window (out of scope).
    const up = b.add(`IFCWINDOW(${b.guid()},$,'Fenster OG',$,$,#${b.place(og.pl, 5, 0, 1)},$,$,1.,1.,.WINDOW.,$,$)`);
    b.pset(up, 'Pset_WindowCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
    b.contain(og.id, up);
    // A stair with two flights, and an interior stair with a readable body inside.
    const flight1 = b.add(`IFCSTAIRFLIGHT(${b.guid()},$,'Lauf 1',$,$,#${b.place(eg.pl, 30, 5, 0)},$,$,$,$,$,$,.STRAIGHT.)`);
    const flight2 = b.add(`IFCSTAIRFLIGHT(${b.guid()},$,'Lauf 2',$,$,#${b.place(eg.pl, 30, 7, 0)},$,$,$,$,$,$,.STRAIGHT.)`);
    const stair = b.add(`IFCSTAIR(${b.guid()},$,'Treppe mit Läufen',$,$,#${b.place(eg.pl, 30, 5, 0)},$,$,.STRAIGHT_RUN_STAIR.)`);
    b.add(`IFCRELAGGREGATES(${b.guid()},$,$,$,#${stair},(#${flight1},#${flight2}))`);
    b.contain(eg.id, stair);
    const inner = b.rectExtrusion(0, 0, 2, 2, 3, b.axis(0, 0, 0), b.dir(0, 0, 1));
    b.contain(eg.id, b.add(`IFCSTAIR(${b.guid()},$,'Innentreppe EG',$,$,#${b.place(eg.pl, 10, 5, 0)},#${b.shape([inner])},$,.STRAIGHT_RUN_STAIR.)`));
    // An opening filled by a proxy (a gate modelled as a proxy), a RECESS, and one with no host.
    const wall = eastWall(b);
    const gateHole = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung Tor Proxy',$,$,#${b.place(eg.pl, 20, 8, 0)},$,$,.OPENING.)`);
    b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${gateHole})`);
    const gate = b.add(`IFCBUILDINGELEMENTPROXY(${b.guid()},$,'Tor Proxy',$,$,#${b.place(eg.pl, 20, 8, 0)},$,$,$)`);
    b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${gateHole},#${gate})`);
    const recess = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Nische',$,$,#${b.place(eg.pl, 20, 2, 0)},$,$,.RECESS.)`);
    b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${recess})`);
    b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Loses Loch',$,$,#${b.place(eg.pl, 20, 3, 0.5)},$,$,.OPENING.)`);
    // A light well above the scope, an elevator with no stated kind, an escalator, and upper-floor equipment.
    b.contain(og.id, b.add(`IFCBUILDINGELEMENTPROXY(${b.guid()},$,'Lichtschacht hoch',$,$,#${b.place(og.pl, 5, -1, 3)},$,$,$)`));
    b.contain(ug.id, b.add(`IFCTRANSPORTELEMENT(${b.guid()},$,'Aufzug',$,$,#${b.place(ug.pl, 15, 5, 0)},$,$,.NOTDEFINED.)`));
    b.contain(eg.id, b.add(`IFCTRANSPORTELEMENT(${b.guid()},$,'Rolltreppe',$,$,#${b.place(eg.pl, 15, 5, 0)},$,$,.ESCALATOR.)`));
    b.contain(og.id, b.add(`IFCBOILER(${b.guid()},$,'Kessel OG',$,$,#${b.place(og.pl, 3, 3, 0)},$,$,.WATER.)`));
  };

  it('no third way out', async () => {
    const store = await parseStep(syntheticHouse({ verticalDatum: 'LN02', extra: zoo }));
    const facts = extractModelFacts(store, { expectedCrs: 'EPSG:2056' });
    const reader = new ModelReader(store);
    const covered = new Set<number>();
    for (const t of ['IFCDOOR', 'IFCDOORSTANDARDCASE', 'IFCWINDOW', 'IFCWINDOWSTANDARDCASE', 'IFCSTAIR', 'IFCSTAIRFLIGHT', 'IFCRAMP', 'IFCRAMPFLIGHT', 'IFCOPENINGELEMENT']) {
      for (const id of reader.idsOfType(t)) covered.add(id);
    }
    for (const { type } of EQUIPMENT_OCCURRENCES) for (const id of reader.idsOfType(type)) covered.add(id);
    for (const t of ['IFCBUILDINGELEMENTPROXY', 'IFCDISTRIBUTIONCHAMBERELEMENT', 'IFCCIVILELEMENT', 'IFCELEMENTASSEMBLY']) {
      for (const id of reader.idsOfType(t)) {
        const e = reader.entity(id)!;
        if (LIGHT_WELL_NAME.test(`${asString(reader.attr(e, 'Name')) ?? ''} ${asString(reader.attr(e, 'ObjectType')) ?? ''}`)) covered.add(id);
      }
    }
    expect(covered.size).toBeGreaterThan(25);
    const candidates = facts.candidates.map((c) => c.expressId);
    const skipped = facts.skipped.map((s) => s.expressId);
    const problems: string[] = [];
    for (const id of covered) {
      const n = candidates.filter((c) => c === id).length + skipped.filter((s) => s === id).length;
      if (n !== 1) problems.push(`#${id} ${reader.className(reader.entity(id)!)} "${asString(reader.attr(reader.entity(id)!, 'Name'))}": ${n} times`);
    }
    expect(problems).toEqual([]);
    for (const s of facts.skipped) expect(s.reason.length).toBeGreaterThan(10);
    // Kept rather than dropped: the elevator with no stated kind, the gate opening filled by a proxy.
    expect(facts.candidates.map((c) => c.name)).toEqual(expect.arrayContaining(['Aufzug', 'Öffnung Tor Proxy', 'Rampe Garage']));
    // An element that could not be placed is named in the warnings, which reach the result.
    expect(facts.warnings.join()).toMatch(/could not be placed .*Tür ohne Platz|Tür ohne Platz.*could not be placed/);
  });
});
