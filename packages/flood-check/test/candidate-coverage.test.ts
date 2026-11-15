/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Candidate selection leaves no third way out: every element of a class the
 * check covers is a candidate or in `skipped` with a reason, and an exclusion
 * that would rest on unreadable or unusually placed data keeps the element.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { RelationshipType } from '@ifc-lite/data';
import { describe, expect, it } from 'vitest';
import { checkFloodExposure } from '../src/check/check.js';
import { extractModelFacts } from '../src/model/extract.js';
import { EQUIPMENT_OCCURRENCES, EQUIPMENT_TYPES, GENERIC_OCCURRENCES } from '../src/model/equipment.js';
import { LIGHT_WELL_NAME } from '../src/model/candidates.js';
import { ModelReader, asString } from '../src/model/reader.js';
import { CELL_NO_RUNOFF, type MapPoint } from '../src/types.js';
import { CODE, CONFIRMED, flatTerrain, syntheticRaster } from './helpers.js';
import { mapOf, ORIGIN, parseStep, ROTATION_DEG, syntheticHouse, type Extra } from './synthetic-model.js';
import { equipment2x3 } from './synthetic-2x3.js';
import type { ModelFacts } from '../src/model/facts.js';

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

/** An unplaceable door filling an opening whose body puts the hole at x 7..8 in an external south wall. */
function unplacedDoorInPlacedOpening(b: Extra) {
  const wall = b.add(`IFCWALL(${b.guid()},$,'Wand Süd 3',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},$,$,.STANDARD.)`);
  b.pset(wall, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
  const hole = b.rectExtrusion(0, 0, 1, 2.1, 0.4, b.axis(7.5, -0.2, 1.05, b.dir(0, 1, 0), b.dir(1, 0, 0)), b.dir(0, 0, 1));
  const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung Tür lose',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([hole])},$,.OPENING.)`);
  b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${opening})`);
  const door = b.add(`IFCDOOR(${b.guid()},$,'Tür lose',$,$,$,$,$,2.1,1.,.DOOR.,$,$)`);
  b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${opening},#${door})`);
  b.contain(b.storeys.eg.id, wall);
  b.contain(b.storeys.eg.id, door);
}

/** An unplaceable external stair whose flight is placed outside the house and descends 2 m. */
function flightOfUnplacedStair(b: Extra) {
  const body = b.rectExtrusion(0, 0, 2, 3, 2, b.axis(0, 0, -2), b.dir(0, 0, 1));
  const flight = b.add(`IFCSTAIRFLIGHT(${b.guid()},$,'Lauf Kellerabgang',$,$,#${b.place(b.storeys.eg.pl, 5, -3, 0)},#${b.shape([body])},$,$,$,$,$,.STRAIGHT.)`);
  const stair = b.add(`IFCSTAIR(${b.guid()},$,'Kellerabgang lose',$,$,$,$,$,.STRAIGHT_RUN_STAIR.)`);
  b.add(`IFCRELAGGREGATES(${b.guid()},$,$,$,#${stair},(#${flight}))`);
  b.contain(b.storeys.eg.id, stair);
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

describe('an element excluded for unreadable data does not take a checkable neighbour with it', () => {
  it('an unplaceable door: its readable opening is checked as a hole, and the door is skipped with a reason', async () => {
    const facts = await extract(unplacedDoorInPlacedOpening);
    const hole = facts.candidates.find((c) => c.name === 'Öffnung Tür lose');
    expect(hole).toMatchObject({ category: 'wall-opening', levelBasis: 'opening-body-bottom' });
    expect(localOf(hole!.position).x).toBeCloseTo(7.5, 1);
    expect(hole!.notes?.join()).toMatch(/filling .* is not a candidate/);
    expect(facts.skipped.find((s) => s.ifcClass === 'IfcDoor' && s.reason === 'no readable IfcLocalPlacement chain')).toBeDefined();
    const r = checkFloodExposure(facts, raster((l) => (l.y < 0 && l.x > 5 && l.x < 10 ? deep : CELL_NO_RUNOFF)), flatTerrain(499.95), { renderingConfirmation: CONFIRMED });
    expect(r.results.find((x) => x.candidate.name === 'Öffnung Tür lose')!.outcome).toBe('exposed');
  });

  it('an unplaceable stair: its placed flight is checked on its own', async () => {
    const facts = await extract(flightOfUnplacedStair);
    expect(facts.candidates.map((c) => c.name)).toContain('Lauf Kellerabgang');
    expect(facts.skipped.find((s) => s.ifcClass === 'IfcStair' && s.reason === 'no readable IfcLocalPlacement chain')).toBeDefined();
  });
});

/** Extra elements that each take a different exit of candidate selection. */
function zooForFixtures(b: Extra) {
  doorAtWallOrigin(b);
  unplacedDoorInPlacedOpening(b);
  flightOfUnplacedStair(b);
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
}

describe('every element of a covered class is a candidate or skipped, exactly once', () => {
  const zoo = zooForFixtures;

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
    expect(facts.candidates.map((c) => c.name)).toEqual(
      expect.arrayContaining(['Aufzug', 'Öffnung Tor Proxy', 'Rampe Garage', 'Öffnung Tür lose', 'Lauf Kellerabgang']),
    );
    // A skip that says another element reports for it is only true when that element is a candidate.
    const candidateIds = new Set(candidates);
    for (const s of facts.skipped) {
      const m = /#(\d+), which is reported for it/.exec(s.reason);
      if (m) expect(candidateIds.has(Number(m[1])), `${s.ifcClass} #${s.expressId}: ${s.reason}`).toBe(true);
    }
    // An element that could not be placed is named in the warnings, which reach the result.
    expect(facts.warnings.join()).toMatch(/could not be placed .*Tür ohne Platz|Tür ohne Platz.*could not be placed/);
  });
});

/** Every element of a covered class in the store, worked out here independently of the selection code. */
function coveredIds(store: IfcDataStore): Map<number, string> {
  const reader = new ModelReader(store);
  const covered = new Map<number, string>();
  const name = (id: number) => `${reader.className(reader.entity(id)!)} "${asString(reader.attr(reader.entity(id)!, 'Name'))}"`;
  for (const t of ['IFCDOOR', 'IFCDOORSTANDARDCASE', 'IFCWINDOW', 'IFCWINDOWSTANDARDCASE', 'IFCSTAIR', 'IFCSTAIRFLIGHT', 'IFCRAMP', 'IFCRAMPFLIGHT', 'IFCOPENINGELEMENT']) {
    for (const id of reader.idsOfType(t)) covered.set(id, name(id));
  }
  for (const { type } of EQUIPMENT_OCCURRENCES) for (const id of reader.idsOfType(type)) covered.set(id, name(id));
  for (const t of GENERIC_OCCURRENCES) {
    for (const id of reader.idsOfType(t)) {
      if (reader.related(id, RelationshipType.DefinesByType, 'inverse').some((tid) => EQUIPMENT_TYPES.has(reader.entity(tid)?.type ?? ''))) covered.set(id, name(id));
    }
  }
  for (const t of ['IFCBUILDINGELEMENTPROXY', 'IFCDISTRIBUTIONCHAMBERELEMENT', 'IFCCIVILELEMENT', 'IFCELEMENTASSEMBLY']) {
    for (const id of reader.idsOfType(t)) {
      const e = reader.entity(id)!;
      if (LIGHT_WELL_NAME.test(`${asString(reader.attr(e, 'Name')) ?? ''} ${asString(reader.attr(e, 'ObjectType')) ?? ''}`)) covered.set(id, name(id));
    }
  }
  return covered;
}

function exactlyOnceProblems(store: IfcDataStore, facts: ModelFacts): string[] {
  const candidates = facts.candidates.map((c) => c.expressId);
  const skipped = facts.skipped.map((s) => s.expressId);
  const problems: string[] = [];
  for (const [id, name] of coveredIds(store)) {
    const n = candidates.filter((c) => c === id).length + skipped.filter((s) => s === id).length;
    if (n !== 1) problems.push(`#${id} ${name}: ${n} times`);
  }
  const ids = new Set(candidates);
  for (const s of facts.skipped) {
    const m = /#(\d+), which is reported for it/.exec(s.reason);
    if (m && !ids.has(Number(m[1]))) problems.push(`${s.ifcClass} #${s.expressId} says #${m[1]} reports for it, which is no candidate`);
  }
  return problems;
}

/** A second building, 20 m east, with a door, a basement window and a boiler. */
function secondBuilding(b: Extra) {
  const pl = b.place(b.site.pl, 40, 0, 0);
  const bld = b.add(`IFCBUILDING(${b.guid()},$,'Nebengebäude',$,$,#${pl},$,$,.ELEMENT.,$,$,$)`);
  b.add(`IFCRELAGGREGATES(${b.guid()},$,$,$,#${b.site.id},(#${bld}))`);
  const egPl = b.place(pl, 0, 0, 0);
  const eg = b.add(`IFCBUILDINGSTOREY(${b.guid()},$,'B EG',$,$,#${egPl},$,$,.ELEMENT.,0.)`);
  b.add(`IFCRELAGGREGATES(${b.guid()},$,$,$,#${bld},(#${eg}))`);
  const door = b.add(`IFCDOOR(${b.guid()},$,'B Tür',$,$,#${b.place(egPl, 10, 0, 0)},$,$,2.1,1.,.DOOR.,$,$)`);
  b.pset(door, 'Pset_DoorCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
  const boiler = b.add(`IFCBOILER(${b.guid()},$,'B Kessel',$,$,#${b.place(egPl, 10, 5, 0)},$,$,.WATER.)`);
  b.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${b.guid()},$,$,$,(#${door},#${boiler}),#${eg})`);
}

async function parseFile(path: string): Promise<IfcDataStore> {
  const b = readFileSync(path);
  return new IfcParser().parseColumnar(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
}

describe('exactly once, over every IFC fixture the tests use', () => {
  const repo = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
  const fixtures: Array<[string, () => Promise<IfcDataStore>, Parameters<typeof extractModelFacts>[1]]> = [
    ['the house', () => parseStep(syntheticHouse({ verticalDatum: 'LN02' })), { expectedCrs: 'EPSG:2056' }],
    ['the house without a slab', () => parseStep(syntheticHouse({ verticalDatum: 'LN02', slab: false })), { expectedCrs: 'EPSG:2056' }],
    ['the house with every exit', () => parseStep(syntheticHouse({ verticalDatum: 'LN02', extra: zooForFixtures })), { expectedCrs: 'EPSG:2056' }],
    ['two buildings', () => parseStep(syntheticHouse({ verticalDatum: 'LN02', extra: secondBuilding })), { expectedCrs: 'EPSG:2056' }],
    ['IFC2X3 equipment', () => parseStep(equipment2x3()), { expectedCrs: 'EPSG:2056' }],
    ['building-architecture.ifc', () => parseFile(repo('apps/viewer/public/samples/building-architecture.ifc')), {}],
  ];
  const miniBim = repo('tests/models/georeferencer/MiniBIM-3.1-DO_01_VORM.ifc');
  if (existsSync(miniBim)) fixtures.push(['MiniBIM (pnpm fixtures)', () => parseFile(miniBim), {}]);

  for (const [label, load, options] of fixtures) {
    it(label, async () => {
      const store = await load();
      const facts = extractModelFacts(store, options);
      expect(exactlyOnceProblems(store, facts)).toEqual([]);
      expect(facts.coverage).toEqual({ walked: coveredIds(store).size, skipped: expect.any(Number) });
      expect(facts.coverage!.walked).toBe(facts.candidates.length + facts.coverage!.skipped);
    });
  }

  it('a candidate that goes missing after extraction fails the invariant in the check, not silently', async () => {
    const facts = extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02' })), { expectedCrs: 'EPSG:2056' });
    const missing = { ...facts, candidates: facts.candidates.slice(1) };
    expect(() => checkFloodExposure(missing, raster(() => CELL_NO_RUNOFF), flatTerrain(499.95), { renderingConfirmation: CONFIRMED })).toThrow(/do not add up/);
    expect(() => checkFloodExposure(facts, raster(() => CELL_NO_RUNOFF), flatTerrain(499.95), { renderingConfirmation: CONFIRMED })).not.toThrow();
  });
});
