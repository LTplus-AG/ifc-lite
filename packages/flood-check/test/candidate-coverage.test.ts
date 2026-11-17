/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Candidate selection leaves no third way out: every element of a class the
 * check covers is a candidate or in `skipped` with a reason, and an exclusion
 * that would rest on unreadable or unusually placed data keeps the element.
 */

import { fixture } from './fixture.js';
import { fileURLToPath } from 'node:url';
import type { IfcDataStore } from '@ifc-lite/parser';
import { RelationshipType } from '@ifc-lite/data';
import { describe, expect, it } from 'vitest';
import { checkFloodExposure } from '../src/check/check.js';
import { extractModelFacts } from '../src/model/extract.js';
import { EQUIPMENT_OCCURRENCES, EQUIPMENT_TYPES, GENERIC_OCCURRENCES } from '../src/model/equipment.js';
import { LIGHT_WELL_NAME } from '../src/model/candidates.js';
import { ModelReader, asString } from '../src/model/reader.js';
import { CELL_NO_RUNOFF } from '../src/types.js';
import { CODE, CONFIRMED, flatTerrain } from './helpers.js';
import { parseStep, syntheticHouse, type Extra } from './synthetic-model.js';
import {
  doorAtWallOrigin,
  flightOfUnplacedStair,
  localOf,
  parseFile,
  raster,
  rampPlacedInside,
  secondBuilding,
  unplacedDoorInPlacedOpening,
  windowWithPartlyReadableOpening,
  zooForFixtures,
} from './candidate-fixtures.js';
import { equipment2x3 } from './synthetic-2x3.js';
import type { ModelFacts } from '../src/model/facts.js';

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

describe('a light well whose body reaches below its placement', () => {
  /** A light-well opening placed at 2 m (502 m) beside the east wall, its body reaching down to -1 m (499 m). */
  const lightWell = (b: Extra) => {
    const body = b.rectExtrusion(0, 0, 1, 1, 3, b.axis(0, 0, -3), b.dir(0, 0, 1));
    b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Lichtschacht Öffnung',$,$,#${b.place(b.storeys.eg.pl, 21, 5, 2)},#${b.shape([body])},$,.OPENING.)`);
  };
  it('is listed at the bottom of its body, so a shallow class cannot clear it', async () => {
    const facts = await extract(lightWell);
    const well = facts.candidates.find((c) => c.name === 'Lichtschacht Öffnung')!;
    expect(well).toMatchObject({ category: 'light-well', levelBasis: 'opening-body-bottom' });
    expect(well.level).toBeCloseTo(499, 3);
    const r = checkFloodExposure(facts, raster(() => shallow), flatTerrain(499.95), { renderingConfirmation: CONFIRMED });
    expect(r.results.find((x) => x.candidate.name === 'Lichtschacht Öffnung')!.outcome).toBe('exposed');
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
  const { path: miniBim, present: hasMiniBim } = fixture('georeferencer/MiniBIM-3.1-DO_01_VORM.ifc');
  if (hasMiniBim) fixtures.push(['MiniBIM (pnpm fixtures)', () => parseFile(miniBim), {}]);

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
