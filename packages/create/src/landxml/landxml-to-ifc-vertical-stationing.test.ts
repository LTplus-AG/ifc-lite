/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * §14.5 — a profile on an alignment with station equations (#5634). Its PVI
 * stations are DISPLAYED stations, placed along the alignment through the
 * written stationing; a station in a gap or displayed twice is refused.
 *
 * The fixture's A-Left carries one forward jump (internal 1200 → displayed
 * 1250) and its profile P-Left is authored in displayed stations by
 * `make_alignment_fixture.py`. The generator designed it in internal stations,
 * so a correct mapping writes the same geometry as a jump-free alignment. The
 * heights are graded by IfcOpenShell in `ifcopenshell-conformance.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { landXmlToIfc } from './landxml-to-ifc.js';
import { collectRefusals } from './refusals.js';
import type { LandXmlIfcAlignment, LandXmlIfcSource } from './source-types.js';

const FIXTURE = JSON.parse(readFileSync(
  resolve(__dirname, '../../../../tools/ifcopenshell_reference/alignment_fixture.json'), 'utf8',
)) as { alignments: LandXmlIfcAlignment[]; profiles: Array<Record<string, unknown> & { name: string }> };

const UNITS = {
  linearUnit: 'meter', elevationUnit: 'meter', linearScaleToMeters: 1, elevationScaleToMeters: 1, assumed: false,
} as const;

function source(alignments: readonly unknown[], profiles: readonly unknown[]): LandXmlIfcSource {
  return { schema: 'LandXML-1.2', version: '1.2', units: UNITS, surfaces: [], alignments, profiles };
}

/** `StartDistAlong` of each IfcAlignmentVerticalSegment in file order. */
function verticalStarts(content: string): number[] {
  return [...content.matchAll(/=IFCALIGNMENTVERTICALSEGMENT\(\$,\$,([^,]+),/g)].map((match) => Number(match[1]));
}

const line = (length: number, staStart: number, stationEquations: unknown[]): LandXmlIfcAlignment => ({
  sourceId: 'landxml:alignment:1:L', name: 'L', staStart, stationEquations,
  segments: [{
    sourceId: 's0', ordinal: 0,
    primitive: {
      kind: 'line', start: { kind: 'coordinates', point: { northing: 0, easting: 0 } },
      end: { kind: 'coordinates', point: { northing: 0, easting: length } }, declaredLength: length,
    },
  }],
});

const equation = (staInternal: number, staAhead: number) => ({
  sourceId: 'landxml:alignment:1:L:station-equation:1', staInternal, staAhead, staBack: null, staIncrement: null,
});

const profile = (pvis: Array<[number, number]>) => ({
  sourceId: 'landxml:profile:1:1:design:P', parentAlignmentSourceId: 'landxml:alignment:1:L', ordinal: 1, name: 'P',
  kind: 'design', verticalCurves: [], gradeLines: [],
  pvis: pvis.map(([station, elevation], index) => ({ sourceId: `pvi:${index}`, station, elevation })),
});

describe('landXmlToIfc — profiles read through station equations (§14.5)', () => {
  it('writes the fixture profile on an alignment with a station equation, placing displayed stations along it', () => {
    const left = FIXTURE.alignments.find((alignment) => alignment.name === 'A-Left')!;
    expect(left.stationEquations, 'the fixture alignment carries its equation').toHaveLength(1);
    const pLeft = FIXTURE.profiles.find((candidate) => candidate.name === 'P-Left')!;
    const result = landXmlToIfc(source([left], [pLeft]), { timestampMs: 0 });
    expect(result.status).toBe('exported');
    if (result.status !== 'exported') return;
    expect(result.refusals.map((refusal) => refusal.family)).not.toContain('profiles');
    expect(result.coverage.profiles).toBe(1);
    // PVIs displayed at 1000 / 1150 / 1350 / 1470 / 1580 lie at 0 / 150 / 300 /
    // 420 / 530 m: past the jump, displayed − staStart would put them 50 m late.
    const starts = verticalStarts(result.content);
    expect(starts).toContain(300);
    expect(starts).not.toContain(350);
    expect(starts.at(-1)).toBe(530);
  });

  it('places a PVI after a forward jump at its one distance along', () => {
    // Internal 1100 → displayed 1150: displayed 1200 is 150 m along, not 200 m.
    const result = landXmlToIfc(source([line(500, 1000, [equation(1100, 1150)])], [profile([[1000, 20], [1200, 24], [1450, 22]])]), { timestampMs: 0 });
    expect(result.status).toBe('exported');
    expect(verticalStarts(result.status === 'exported' ? result.content : '')).toEqual([0, 150, 400]);
  });

  it.each([
    ['a PVI in a forward jump\'s gap', [equation(1100, 1150)], [[1000, 20], [1120, 24], [1400, 22]],
      /'P': its PVI 2 is at station 1120, which falls in a station-equation gap of 'L'/],
    ['a PVI displayed twice after a backward jump', [equation(1200, 1100)], [[1000, 20], [1200, 24], [1400, 22]],
      /'P': its PVI 2 is at station 1200, which 'L' displays at 2 places \(200\.000 m, 300\.000 m\); choosing one would be a guess/],
  ] as const)('refuses %s, naming it, and still writes the alignment', (_case, equations, pvis, reason) => {
    const input = source([line(500, 1000, [...equations])], [profile(pvis.map(([s, e]) => [s, e]))]);
    const row = collectRefusals(input).find((refusal) => refusal.family === 'profiles');
    expect(row?.message).toMatch(reason);
    const result = landXmlToIfc(input, { timestampMs: 0 });
    expect(result.status).toBe('exported');
    if (result.status !== 'exported') return;
    expect(result.content).not.toContain('IFCALIGNMENTVERTICAL(');
    expect(result.content.match(/=IFCREFERENT\(/g), 'the equation itself is still written').toHaveLength(2);
  });
});
