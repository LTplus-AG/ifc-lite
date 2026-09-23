/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LandXML horizontal alignment → `IfcAlignmentHorizontalSegment` parameters
 * (mapping spec §11). Every case here is a place a sign or an axis hides: a
 * transposed or mirrored alignment is still a smooth, plausible curve, so only
 * a numeric assertion against a known answer catches it.
 *
 * `alignment_fixture.json` is authored by `tools/ifcopenshell_reference/
 * make_alignment_fixture.py`, which integrates the geometry independently of
 * this module — so the fixture checks here are not this module agreeing with
 * itself.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALIGNMENT_POSITION_TOLERANCE_M, cogoPointResolver, evaluateSegment, mapAlignments, type PointResolver,
} from './alignment-mapping.js';
import type {
  LandXmlIfcAlignment, LandXmlIfcAlignmentPrimitive, LandXmlIfcLocation, LandXmlIfcUnits,
} from './source-types.js';

const METRES: LandXmlIfcUnits = {
  linearUnit: 'meter', elevationUnit: 'meter',
  linearScaleToMeters: 1, elevationScaleToMeters: 1, assumed: false,
};
const noRefs = () => null;

/** LandXML authors plan points northing-first. */
function at(easting: number, northing: number): LandXmlIfcLocation {
  return { kind: 'coordinates', point: { northing, easting } };
}

function alignment(...primitives: LandXmlIfcAlignmentPrimitive[]): LandXmlIfcAlignment {
  return {
    sourceId: 'landxml:alignment:t', name: 'T', staStart: 0,
    segments: primitives.map((primitive, ordinal) => ({ sourceId: `s${ordinal}`, ordinal, primitive })),
  };
}

function mapOne(value: LandXmlIfcAlignment, units: LandXmlIfcUnits = METRES, swap = false) {
  return mapAlignments([value], units, swap, noRefs);
}

describe('mapAlignments — axes and signs (§11.3)', () => {
  it('reads northing-first points into (easting, northing) and measures direction from east', () => {
    // A line due NORTH: easting constant, northing grows. Transposed, it would
    // run due east — still a perfectly plausible line.
    const { mapped, refused } = mapOne(alignment({
      kind: 'line', start: at(1000, 5000), end: at(1000, 5100), declaredLength: 100,
    }));
    expect(refused).toEqual([]);
    const [segment] = mapped[0].segments;
    expect(segment.start).toEqual([1000, 5000]);
    expect(segment.direction).toBeCloseTo(Math.PI / 2, 12);
    expect(segment.length).toBeCloseTo(100, 12);
  });

  it('writes a counter-clockwise arc with a POSITIVE radius and a clockwise arc with a NEGATIVE one', () => {
    // Both start at the origin heading east with radius 100; one turns left
    // (centre north), one right (centre south).
    const left = mapOne(alignment({
      kind: 'curve', start: at(0, 0), center: at(0, 100), end: at(100, 100),
      rotation: 'counter_clockwise', radius: 100, declaredLength: null,
    })).mapped[0].segments[0];
    const right = mapOne(alignment({
      kind: 'curve', start: at(0, 0), center: at(0, -100), end: at(100, -100),
      rotation: 'clockwise', radius: 100, declaredLength: null,
    })).mapped[0].segments[0];

    expect(left.startRadius).toBeCloseTo(100, 9);
    expect(right.startRadius).toBeCloseTo(-100, 9);
    // Both leave the origin heading east — the tangent, not the radial.
    expect(left.direction).toBeCloseTo(0, 12);
    expect(Math.cos(right.direction)).toBeCloseTo(1, 12);
    // A quarter circle each way.
    expect(left.length).toBeCloseTo((Math.PI / 2) * 100, 9);
    expect(right.length).toBeCloseTo((Math.PI / 2) * 100, 9);
  });

  it('writes an infinite spiral radius as 0 and signs the finite one by the turn', () => {
    const fixture = readFixture();
    const right = fixture.alignments.find((a) => a.name === 'A-Right')!;
    const spiral = mapOne(right).mapped[0].segments[1];
    expect(spiral.type).toBe('CLOTHOID');
    expect(spiral.startRadius).toBe(0);
    expect(spiral.endRadius).toBeCloseTo(-150, 9);
  });

  it('reads a spiral turn from its PI when no rot is authored', () => {
    const fixture = readFixture();
    const left = fixture.alignments.find((a) => a.name === 'A-Left')!;
    const stripped: LandXmlIfcAlignment = {
      ...left,
      segments: left.segments.map((segment) => (segment.primitive.kind === 'spiral'
        ? { ...segment, primitive: { ...segment.primitive, rotation: undefined } }
        : segment)),
    };
    const { mapped, refused } = mapOne(stripped);
    expect(refused).toEqual([]);
    expect(mapped[0].segments[1].endRadius).toBeCloseTo(300, 9);
  });

  it('applies the linear unit to coordinates, radii, lengths and station alike', () => {
    const feet = { ...METRES, linearUnit: 'USSurveyFoot', linearScaleToMeters: 1200 / 3937 };
    const { mapped } = mapOne({
      ...alignment({
        kind: 'curve', start: at(0, 0), center: at(0, 100), end: at(100, 100),
        rotation: 'counter_clockwise', radius: 100, declaredLength: null,
      }),
      staStart: 1000,
    }, feet);
    const [arc] = mapped[0].segments;
    expect(arc.startRadius).toBeCloseTo(100 * feet.linearScaleToMeters, 9);
    expect(arc.length).toBeCloseTo((Math.PI / 2) * 100 * feet.linearScaleToMeters, 9);
    expect(mapped[0].startStation).toBeCloseTo(1000 * feet.linearScaleToMeters, 9);
  });

  it('honours the operator coordinate-order override', () => {
    const { mapped } = mapOne(alignment({
      kind: 'line', start: at(1000, 5000), end: at(1000, 5100), declaredLength: 100,
    }), METRES, true);
    // Swapped back: the authored "northing" field is read as the easting.
    expect(mapped[0].segments[0].start).toEqual([5000, 1000]);
  });
});

describe('mapAlignments — the fixture authored independently of this module', () => {
  it('maps all three fixture alignments and lands every segment on its authored end', () => {
    const fixture = readFixture();
    const { mapped, refused } = mapAlignments(fixture.alignments, METRES, false, noRefs);
    expect(refused).toEqual([]);
    expect(mapped.map((a) => a.name)).toEqual(['A-Left', 'A-Right', 'A-Compound']);
    for (const value of mapped) {
      const authored = fixture.authored[value.name];
      expect(value.segments.length + 1).toBe(authored.length);
      value.segments.forEach((segment, index) => {
        const [ex, ey] = authored[index + 1];
        // Tighter than the refusal tolerance: a correct mapping reproduces an
        // exact fixture to well under a millimetre.
        expect(Math.hypot(segment.end[0] - ex, segment.end[1] - ey)).toBeLessThan(1e-3);
      });
    }
  });
});

describe('mapAlignments — refusals (§11.2, §11.4)', () => {
  const reasonOf = (value: LandXmlIfcAlignment, resolve: PointResolver = noRefs) =>
    mapAlignments([value], METRES, false, resolve).refused[0]?.reason ?? '';

  it('refuses a curve whose rot contradicts its declared length — a flipped arc', () => {
    // Centre north of a start heading east, ending a quarter turn left: a 90°
    // counter-clockwise arc of length 50π. Declared clockwise, it is the OTHER
    // arc of the same circle — 270°, 150π — ending at the same point, so the
    // end-point check alone cannot see it. The declared length can.
    const reason = reasonOf(alignment({
      kind: 'curve', start: at(0, 0), center: at(0, 100), end: at(100, 100),
      rotation: 'clockwise', radius: 100, declaredLength: 50 * Math.PI,
    }));
    expect(reason).toMatch(/declares 157\.080 m — its rotation may be the other way round/);
  });

  it('cannot tell a flipped arc without a declared length, and says so by writing the arc it was given', () => {
    // Documents the limit rather than hiding it: with no length, start/centre/
    // end are equally consistent with both arcs, so the authored `rot` is
    // taken at its word and the 270° arc is written.
    const { mapped, refused } = mapOne(alignment({
      kind: 'curve', start: at(0, 0), center: at(0, 100), end: at(100, 100),
      rotation: 'clockwise', radius: 100, declaredLength: null,
    }));
    expect(refused).toEqual([]);
    expect(mapped[0].segments[0].length).toBeCloseTo(150 * Math.PI, 9);
  });

  it('refuses a spiral whose rot is flipped', () => {
    const fixture = readFixture();
    const left = fixture.alignments.find((a) => a.name === 'A-Left')!;
    const flipped: LandXmlIfcAlignment = {
      ...left,
      segments: left.segments.map((segment, index) => (index === 1 && segment.primitive.kind === 'spiral'
        ? { ...segment, primitive: { ...segment.primitive, rotation: 'clockwise' as const } }
        : segment)),
    };
    expect(reasonOf(flipped)).toMatch(/segment 2's parameters end .* from its authored end point/);
  });

  it('refuses a gap between consecutive segments, naming both', () => {
    const reason = reasonOf(alignment(
      { kind: 'line', start: at(0, 0), end: at(100, 0), declaredLength: 100 },
      { kind: 'line', start: at(100.5, 0), end: at(200, 0), declaredLength: 99.5 },
    ));
    expect(reason).toBe('segment 2 starts 0.500 m from where segment 1 ends');
  });

  it('accepts a join inside the tolerance', () => {
    const { refused } = mapOne(alignment(
      { kind: 'line', start: at(0, 0), end: at(100, 0), declaredLength: 100 },
      { kind: 'line', start: at(100 + ALIGNMENT_POSITION_TOLERANCE_M / 2, 0), end: at(200, 0), declaredLength: 100 },
    ));
    expect(refused).toEqual([]);
  });

  it('refuses an IrregularLine, a non-clothoid spiral and an unsupported spiral by name', () => {
    expect(reasonOf(alignment({ kind: 'irregular_line', start: at(0, 0), end: at(1, 1), declaredLength: null })))
      .toMatch(/IrregularLine/);
    const spiral = { start: at(0, 0), pi: at(50, 0), end: at(99, 5), radiusStart: 'infinite' as const, radiusEnd: 300, declaredLength: 100 };
    expect(reasonOf(alignment({ kind: 'spiral', spiType: 'bloss', ...spiral }))).toMatch(/'bloss' spiral/);
    expect(reasonOf(alignment({ kind: 'unsupported_spiral', spiType: 'cubic', ...spiral }))).toMatch(/'cubic' spiral/);
  });

  it('refuses an unresolved or ambiguous point reference, and resolves a unique one', () => {
    const line = alignment({
      kind: 'line', start: { kind: 'point_reference', pntRef: 'BM1' }, end: at(100, 0), declaredLength: 100,
    });
    expect(reasonOf(line)).toMatch(/references point 'BM1'/);

    const twice = cogoPointResolver([
      { name: 'BM1', point: { northing: 0, easting: 0 } },
      { name: 'BM1', point: { northing: 9, easting: 9 } },
    ]);
    // Guessing which of two same-named points was meant would silently move
    // the alignment.
    expect(reasonOf(line, twice)).toMatch(/does not define uniquely/);

    const once = cogoPointResolver([{ name: 'BM1', point: { northing: 0, easting: 0 } }]);
    expect(mapAlignments([line], METRES, false, once).refused).toEqual([]);
  });

  it('refuses an alignment with no geometry, and every alignment when there are no units', () => {
    expect(reasonOf({ sourceId: 'x', name: 'Empty', staStart: 0, segments: [] })).toBe('it has no horizontal geometry');
    const fixture = readFixture();
    const refused = mapAlignments(fixture.alignments, null, false, noRefs).refused;
    expect(refused.map((entry) => entry.reason)).toEqual(Array(3).fill('the file declares no units'));
  });

  it('refuses a spiral with equal start and end radius — it is not a transition', () => {
    expect(reasonOf(alignment({
      kind: 'spiral', spiType: 'clothoid', start: at(0, 0), pi: at(50, 0), end: at(99, 5),
      radiusStart: 300, radiusEnd: 300, rotation: 'counter_clockwise', declaredLength: 100,
    }))).toMatch(/equal start and end radius/);
  });
});

describe('evaluateSegment', () => {
  it('closes a full counter-clockwise circle back on its start', () => {
    const { point, direction } = evaluateSegment([10, 20], 0, 1 / 50, 1 / 50, 2 * Math.PI * 50);
    expect(point[0]).toBeCloseTo(10, 6);
    expect(point[1]).toBeCloseTo(20, 6);
    expect(direction).toBeCloseTo(2 * Math.PI, 9);
  });
});

function readFixture(): {
  alignments: LandXmlIfcAlignment[];
  authored: Record<string, Array<[number, number]>>;
} {
  return JSON.parse(readFileSync(
    resolve(__dirname, '../../../../tools/ifcopenshell_reference/alignment_fixture.json'), 'utf8',
  ));
}
