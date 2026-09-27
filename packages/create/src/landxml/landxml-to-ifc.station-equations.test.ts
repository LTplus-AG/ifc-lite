/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * §14 of `docs/architecture/landxml-to-ifc-mapping.md` — LandXML station
 * equations written as `IfcReferent` / `.STATION.` with `Pset_Stationing`
 * (#5634).
 *
 * `alignment_fixture.json` is authored by `tools/ifcopenshell_reference/
 * make_alignment_fixture.py`, independently of the mapping, and carries the
 * expected value of every referent under `referents`. Where each referent
 * lands on the curve is graded by IfcOpenShell in
 * `ifcopenshell-conformance.test.ts`; these cases pin the stationing values,
 * the nest order, the refusals and the accounting.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IfcCreator } from '../ifc-creator.js';
import { landXmlGlobalId, landXmlToIfc } from './landxml-to-ifc.js';
import type { LandXmlIfcAlignment, LandXmlIfcSource, LandXmlIfcUnits } from './source-types.js';
import type { LandXmlIfcResult } from './result-types.js';

interface ExpectedEquation {
  distanceAlong: number;
  station: number;
  incomingStation: number;
  hasIncreasingStation: boolean | null;
}

interface Fixture {
  alignments: LandXmlIfcAlignment[];
  referents: Record<string, { startStation: number; equations: ExpectedEquation[] }>;
}

const METRES: LandXmlIfcUnits = {
  linearUnit: 'meter', elevationUnit: 'meter', linearScaleToMeters: 1, elevationScaleToMeters: 1, assumed: false,
};

function fixture(): Fixture {
  return JSON.parse(readFileSync(
    resolve(__dirname, '../../../../tools/ifcopenshell_reference/alignment_fixture.json'), 'utf8',
  )) as Fixture;
}

function source(alignments: readonly unknown[], units: LandXmlIfcUnits = METRES): LandXmlIfcSource {
  return { schema: 'LandXML-1.2', version: '1.2', units, surfaces: [], alignments };
}

function exported(result: LandXmlIfcResult): string {
  expect(result.status).toBe('exported');
  return result.status === 'exported' ? result.content : '';
}

/** `#id` → the STEP row's attribute text. */
function rows(content: string): Map<string, { type: string; attrs: string }> {
  const out = new Map<string, { type: string; attrs: string }>();
  for (const match of content.matchAll(/^#(\d+)=([A-Z0-9]+)\((.*)\);$/gm)) {
    out.set(`#${match[1]}`, { type: match[2], attrs: match[3] });
  }
  return out;
}

/** What a reader finds for each referent of one alignment, in nest order. */
function readReferents(content: string, alignmentName: string): Array<{
  globalId: string; name: string; distanceAlong: number; properties: Record<string, string>;
}> {
  const table = rows(content);
  const alignmentId = [...table].find(([, row]) => row.type === 'IFCALIGNMENT' && row.attrs.includes(`,'${alignmentName}',`))?.[0];
  expect(alignmentId, `alignment ${alignmentName} is written`).toBeDefined();
  // IfcRelNests(GlobalId, OwnerHistory, Name, Description, RelatingObject, RelatedObjects).
  const nests = [...table.values()]
    .filter((row) => row.type === 'IFCRELNESTS')
    .map((row) => /^'[^']*',#\d+,\$,\$,(#\d+),\(([^)]*)\)$/.exec(row.attrs)!)
    .filter(([, relating, members]) => relating === alignmentId && table.get(members.split(',')[0])?.type === 'IFCREFERENT');
  expect(nests, 'the alignment has exactly one referent nest').toHaveLength(1);
  const members = nests[0][2].split(',');
  return members.map((id) => {
    const referent = table.get(id)!;
    expect(referent.type).toBe('IFCREFERENT');
    const [, globalId, name, placementRef] = /^'([^']+)',#\d+,'([^']*)',\$,\$,(#\d+),/.exec(referent.attrs)!;
    const linear = table.get(/^\$,(#\d+),/.exec(table.get(placementRef)!.attrs)![1])!;
    const along = table.get(/^(#\d+)/.exec(linear.attrs)![1])!;
    const distanceAlong = Number(/^IFCLENGTHMEASURE\(([^)]+)\)/.exec(along.attrs)![1]);
    const rel = [...table.values()].find((row) => row.type === 'IFCRELDEFINESBYPROPERTIES' && row.attrs.includes(`(${id}),`))!;
    const pset = table.get(/,(#\d+)$/.exec(rel.attrs)![1])!;
    expect(pset.attrs).toContain("'Pset_Stationing'");
    const properties: Record<string, string> = {};
    for (const ref of /\(([^()]*)\)$/.exec(pset.attrs)![1].split(',')) {
      const [, key, value] = /^'([^']+)',\$,IFC[A-Z]+\(([^)]+)\),\$$/.exec(table.get(ref)!.attrs)!;
      properties[key] = value;
    }
    return { globalId, name, distanceAlong, properties };
  });
}

describe('landXmlToIfc — station equations as IfcReferent (§14, #5634)', () => {
  it('writes every station equation of the fixture, and refuses none', () => {
    const result = landXmlToIfc(source(fixture().alignments), { timestampMs: 0 });
    const content = exported(result);
    // 3 start referents + 1 (A-Left) + 3 (A-Compound) equations.
    expect(content.match(/=IFCREFERENT\(/g)).toHaveLength(7);
    expect(result.refusals.map((refusal) => refusal.family)).not.toContain('station-equations');
  });

  it('writes Station, IncomingStation and HasIncreasingStation as authored, nested in order along the alignment', () => {
    const { alignments, referents } = fixture();
    const content = exported(landXmlToIfc(source(alignments), { timestampMs: 0 }));
    for (const [name, expected] of Object.entries(referents)) {
      const read = readReferents(content, name);
      expect(read).toHaveLength(1 + expected.equations.length);
      expect(read[0].distanceAlong).toBe(0);
      expect(Number(read[0].properties.Station)).toBe(expected.startStation);
      expect(read[0].properties.IncomingStation, 'the start referent is not an equation').toBeUndefined();
      expected.equations.forEach((equation, index) => {
        const referent = read[index + 1];
        expect(referent.distanceAlong).toBeCloseTo(equation.distanceAlong, 9);
        expect(Number(referent.properties.Station)).toBeCloseTo(equation.station, 9);
        expect(Number(referent.properties.IncomingStation)).toBeCloseTo(equation.incomingStation, 9);
        expect(referent.properties.HasIncreasingStation).toBe(
          equation.hasIncreasingStation === null ? undefined : equation.hasIncreasingStation ? '.T.' : '.F.',
        );
      });
    }
  });

  it('orders the nest by distance along, not by Station, when stationing jumps back', () => {
    // A-Compound: 0+250 at 0 m, then back to 0+200 at 80 m. Sorting by
    // Station (as IfcOpenShell's add_stationing_referent does) would put the
    // 80 m referent before the start one.
    const content = exported(landXmlToIfc(source(fixture().alignments), { timestampMs: 0 }));
    const read = readReferents(content, 'A-Compound');
    expect(read.map((referent) => referent.name)).toEqual(['0+250.000', '0+200.000', '0+500.000', '2+000.000']);
    expect(read.map((referent) => referent.distanceAlong)).toEqual([0, 80, 150, 270]);
  });

  it('derives an unauthored IncomingStation from the running stationing, honouring a decreasing run', () => {
    // A-Compound: at 150 m the station becomes 500 DECREASING; at 270 m (no
    // staBack) the incoming station is 500 − 120 = 380.
    const content = exported(landXmlToIfc(source(fixture().alignments), { timestampMs: 0 }));
    const [, , decreasing, derived] = readReferents(content, 'A-Compound');
    expect(decreasing.properties.HasIncreasingStation).toBe('.F.');
    expect(Number(derived.properties.IncomingStation)).toBe(380);
  });

  it("derives each equation referent's GlobalId from the equation's own source id (§4.3)", () => {
    const content = exported(landXmlToIfc(source(fixture().alignments), { timestampMs: 0 }));
    const [, first] = readReferents(content, 'A-Left');
    expect(first.globalId).toBe(landXmlGlobalId('landxml:alignment:1:station-equation:1'));
  });

  it('scales stations and distances by the declared linear unit', () => {
    const feet: LandXmlIfcUnits = { ...METRES, linearUnit: 'foot', elevationUnit: 'foot', linearScaleToMeters: 0.3048, elevationScaleToMeters: 0.3048 };
    const at = (easting: number) => ({ kind: 'coordinates' as const, point: { northing: 0, easting } });
    const content = exported(landXmlToIfc(source([{
      sourceId: 'landxml:alignment:ft', name: 'Feet', staStart: 1000,
      segments: [{ sourceId: 's', ordinal: 0, primitive: { kind: 'line', start: at(0), end: at(1000), declaredLength: null } }],
      stationEquations: [{ sourceId: 'landxml:alignment:ft:station-equation:1', staInternal: 1500, staAhead: 5000, staBack: null, staIncrement: null }],
    }], feet), { timestampMs: 0 }));
    const [, equation] = readReferents(content, 'Feet');
    expect(equation.distanceAlong).toBeCloseTo(500 * 0.3048, 9);
    expect(Number(equation.properties.Station)).toBeCloseTo(5000 * 0.3048, 9);
    expect(Number(equation.properties.IncomingStation)).toBeCloseTo(1500 * 0.3048, 9);
  });
});

describe('landXmlToIfc — station equations refused all or none (§14.2)', () => {
  function withEquations(equations: unknown[]): LandXmlIfcSource {
    const [left] = fixture().alignments;
    return source([{ ...left, stationEquations: equations }]);
  }
  const ok = { sourceId: 'landxml:alignment:1:station-equation:1', staInternal: 1100, staAhead: 1200, staBack: null, staIncrement: null };

  it.each([
    ['a malformed record', [ok, { sourceId: 'x', staInternal: 'soon', staAhead: 1 }], /station equation 2 is not a station-equation record/],
    ['one at the start', [{ ...ok, staInternal: 1000 }], /station equation 1 is at internal station 1000, at or before the alignment's start/],
    ['one beyond the end', [ok, { ...ok, sourceId: 'e2', staInternal: 1600 }], /station equation 2 is 70\.000 m beyond the alignment's end/],
    ['one out of order', [ok, { ...ok, sourceId: 'e2', staInternal: 1050 }], /station equation 2 is not after station equation 1/],
  ])('refuses every equation of an alignment carrying %s, naming it, and still writes the alignment', (_case, equations, reason) => {
    const result = landXmlToIfc(withEquations(equations), { timestampMs: 0 });
    const content = exported(result);
    const row = result.refusals.find((refusal) => refusal.family === 'station-equations');
    expect(row?.count).toBe(equations.length);
    expect(row?.message).toMatch(reason);
    expect(row?.message).toContain("'A-Left'");
    // All or none: the valid first equation is not written either.
    expect(content.match(/=IFCREFERENT\(/g)).toHaveLength(1);
    expect(content.match(/=IFCALIGNMENT\(/g)).toHaveLength(1);
  });
});

describe('TerrainWriter.addAlignment — station equations', () => {
  it('refuses equations that are not in order along the alignment rather than mis-nesting them', () => {
    const creator = new IfcCreator({ Schema: 'IFC4X3', Name: 'order', LengthUnit: 'METRE' });
    const line = {
      sourceId: 's', type: 'LINE' as const, start: [0, 0] as const, direction: 0, startRadius: 0, endRadius: 0,
      length: 100, end: [100, 0] as const, endDirection: 0, startCurvature: 0, endCurvature: 0,
    };
    expect(() => creator.terrain().addAlignment({
      Name: 'Order', StartStation: 0, Segments: [line],
      StationEquations: [
        { DistanceAlong: 60, Station: 200, IncomingStation: 60 },
        { DistanceAlong: 40, Station: 300, IncomingStation: 180 },
      ],
    })).toThrow(/station equation 2 is at 40 along the alignment, not after the previous referent/);
  });
});
