/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LandXML design profiles → `IfcAlignmentVertical` (mapping spec §12).
 *
 * Entered through `landXmlToIfc` and `collectRefusals` — the converter's
 * public seams — and asserted on the STEP it writes. Heights are checked
 * against `alignment_fixture.json`'s `authoredVertical`, which
 * `tools/ifcopenshell_reference/make_alignment_fixture.py` evaluates from the
 * LandXML definition of each curve, independently of this package; the
 * segments are read back from the STEP and evaluated here by IFC's own
 * definition of each segment type, so neither side is the mapper grading
 * itself. The IfcOpenShell cross-check is `ifcopenshell-conformance.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { landXmlGlobalId, landXmlToIfc } from './landxml-to-ifc.js';
import { collectRefusals } from './refusals.js';
import { IfcCreator } from '../ifc-creator.js';
import { polynomialLength } from '../ifc-creator-alignment-vertical.js';
import type { HorizontalSegment } from './alignment-mapping.js';
import type { VerticalSegment } from './profile-geometry.js';
import type { LandXmlIfcAlignment, LandXmlIfcSource, LandXmlIfcUnits } from './source-types.js';

const FIXTURE = JSON.parse(readFileSync(
  resolve(__dirname, '../../../../tools/ifcopenshell_reference/alignment_fixture.json'), 'utf8',
)) as {
  alignments: LandXmlIfcAlignment[];
  profiles: Array<Record<string, unknown> & { sourceId: string; name: string; parentAlignmentSourceId: string }>;
  authoredVertical: Record<string, { staStart: number; heights: Array<[number, number]> }>;
};

const METRES: LandXmlIfcUnits = {
  linearUnit: 'meter', elevationUnit: 'meter', linearScaleToMeters: 1, elevationScaleToMeters: 1, assumed: false,
};

function exported(source: LandXmlIfcSource): string {
  const result = landXmlToIfc(source, { timestampMs: 0 });
  if (result.status !== 'exported') throw new Error(`expected an export, got: ${result.reason}`);
  return result.content;
}

function fixtureSource(): LandXmlIfcSource {
  return {
    schema: 'LandXML-1.2', version: '1.2', units: METRES, surfaces: [],
    alignments: structuredClone(FIXTURE.alignments), profiles: structuredClone(FIXTURE.profiles),
  };
}

// --- A minimal STEP reader: enough to walk nests and read design parameters. ---

type Step = Map<number, { type: string; args: string }>;

function parseStep(content: string): Step {
  const step: Step = new Map();
  for (const line of content.split('\n')) {
    const match = /^#(\d+)=([A-Z0-9]+)\((.*)\);$/.exec(line.trim());
    if (match) step.set(Number(match[1]), { type: match[2], args: match[3] });
  }
  return step;
}

const refs = (text: string): number[] => [...text.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

function byType(step: Step, type: string): Array<[number, string]> {
  return [...step].filter(([, entity]) => entity.type === type).map(([id, entity]) => [id, entity.args]);
}

interface Design { type: string; d: number; L: number; h: number; g0: number; g1: number; R: number | null }

/** The vertical layout's segments, in nest order, per IfcAlignmentVertical Name. */
function verticalLayouts(step: Step): Map<string, Design[]> {
  const layouts = new Map<string, Design[]>();
  for (const [id, args] of byType(step, 'IFCALIGNMENTVERTICAL')) {
    const name = /^'[^']*',#\d+,'([^']*)'/.exec(args)?.[1] ?? '';
    const nest = byType(step, 'IFCRELNESTS').find(([, a]) => refs(a)[1] === id);
    const segments = refs(nest![1]).slice(2).map((segmentId) => {
      const designId = refs(step.get(segmentId)!.args).at(-1)!;
      const fields = step.get(designId)!.args.split(',');
      return {
        type: fields[8].replace(/\./g, ''), d: Number(fields[2]), L: Number(fields[3]), h: Number(fields[4]),
        g0: Number(fields[5]), g1: Number(fields[6]), R: fields[7] === '$' ? null : Number(fields[7]),
      };
    });
    // Keyed by name for readable tests; two layouts sharing a name must not
    // silently overwrite each other and hide one from the height checks.
    if (layouts.has(name)) throw new Error(`two vertical layouts are named '${name}'`);
    layouts.set(name, segments);
  }
  return layouts;
}

/** Height at distance `s` along, by IFC's definition of each segment type. */
function heightAt(segments: readonly Design[], s: number): number {
  const segment = segments.find((candidate) => s >= candidate.d - 1e-9 && s <= candidate.d + candidate.L + 1e-9);
  if (!segment) throw new Error(`distance ${s} is outside the vertical layout`);
  const x = s - segment.d;
  if (segment.type === 'CONSTANTGRADIENT') return segment.h + segment.g0 * x;
  if (segment.type === 'PARABOLICARC') return segment.h + segment.g0 * x + ((segment.g1 - segment.g0) * x * x) / (2 * segment.L);
  // CIRCULARARC: the centre lies |R| along the normal on the side R's sign names.
  const R = segment.R!;
  const t = Math.atan(segment.g0);
  const cx = -R * Math.sin(t);
  const cy = segment.h + R * Math.cos(t);
  return cy - Math.sign(R) * Math.sqrt(R * R - (x - cx) ** 2);
}

describe('landXmlToIfc — vertical profiles (§12)', () => {
  it('writes each design profile as an IfcAlignmentVertical nested beside its horizontal layout', () => {
    const result = landXmlToIfc(fixtureSource(), { timestampMs: 0 });
    expect(result.status).toBe('exported');
    if (result.status !== 'exported') return;
    expect(result.coverage.profiles).toBe(2);
    expect(result.refusals.find((refusal) => refusal.family === 'profiles')).toBeUndefined();
    const step = parseStep(result.content);
    const verticals = byType(step, 'IFCALIGNMENTVERTICAL');
    expect(verticals.map(([, args]) => /'([^']*)',\$,\$,\$,\$$/.exec(args)?.[1])).toEqual(['P-Left', 'P-Right']);
    for (const [verticalId] of verticals) {
      // Nested by the alignment together with its horizontal layout, horizontal first.
      const nest = byType(step, 'IFCRELNESTS').find(([, args]) => refs(args).slice(2).includes(verticalId));
      const [, , ...related] = refs(nest![1]);
      expect(related).toHaveLength(2);
      expect(step.get(related[0])!.type).toBe('IFCALIGNMENTHORIZONTAL');
      expect(step.get(related[1])!.type).toBe('IFCALIGNMENTVERTICAL');
      expect(step.get(refs(nest![1])[1])!.type).toBe('IFCALIGNMENT');
    }
    const [first] = verticals;
    expect(step.get(first[0])!.args.startsWith(`'${landXmlGlobalId(FIXTURE.profiles[0].sourceId)}'`)).toBe(true);
  });

  it('passes through every height the LandXML profile defines, at each PVI and each curve boundary', () => {
    const layouts = verticalLayouts(parseStep(exported(fixtureSource())));
    for (const [alignmentName, profileName] of [['A-Left', 'P-Left'], ['A-Right', 'P-Right']]) {
      const { staStart, heights } = FIXTURE.authoredVertical[alignmentName];
      const segments = layouts.get(profileName)!;
      expect(heights.length).toBeGreaterThan(10);
      for (const [station, height] of heights) {
        expect(heightAt(segments, station - staStart), `${profileName} at station ${station}`).toBeCloseTo(height, 9);
      }
    }
  });

  it('writes grades, a crest and a sag with the radius sign IFC defines, and an unsymmetrical curve as two parabolas', () => {
    const layouts = verticalLayouts(parseStep(exported(fixtureSource())));
    const summary = (name: string) => layouts.get(name)!.map((s) => [s.type, s.R === null ? null : Math.sign(s.R)]);
    // Crest parabola (R < 0), bare grade break, sag circle (R > 0), terminator.
    expect(summary('P-Left')).toEqual([
      ['CONSTANTGRADIENT', null], ['PARABOLICARC', -1], ['CONSTANTGRADIENT', null], ['CONSTANTGRADIENT', null],
      ['CIRCULARARC', 1], ['CONSTANTGRADIENT', null], ['CONSTANTGRADIENT', null],
    ]);
    // Sag parabola, then the unsymmetrical crest as two parabolas meeting at its PVI.
    expect(summary('P-Right')).toEqual([
      ['CONSTANTGRADIENT', null], ['PARABOLICARC', 1], ['CONSTANTGRADIENT', null], ['PARABOLICARC', -1],
      ['PARABOLICARC', -1], ['CONSTANTGRADIENT', null], ['CONSTANTGRADIENT', null],
    ]);
    const right = layouts.get('P-Right')!;
    expect(right[3].d + right[3].L).toBeCloseTo(260, 12); // lengthIn 40 ends at the PVI station
    expect(right[3].L).toBeCloseTo(40, 12);
    expect(right[4].L).toBeCloseTo(70, 12);
    expect(right[3].g1).toBeCloseTo(right[4].g0, 15);
    const left = layouts.get('P-Left')!;
    expect(left[4].R).toBe(2000);
    expect(left[1].R).toBeCloseTo(80 / (-0.01 - 0.02), 9);
    expect(left.at(-1)!.L).toBe(0);
  });

  it('writes an IfcGradientCurve over the composite curve as Axis/Curve3D, moving the composite to FootPrint', () => {
    const step = parseStep(exported(fixtureSource()));
    const representations = byType(step, 'IFCSHAPEREPRESENTATION').map(([, args]) => args);
    const gradientCurves = byType(step, 'IFCGRADIENTCURVE');
    expect(gradientCurves).toHaveLength(2);
    for (const [id, args] of gradientCurves) {
      const base = refs(args).at(-1)!;
      expect(step.get(base)!.type).toBe('IFCCOMPOSITECURVE');
      expect(representations.some((r) => r.includes(`'Axis','Curve3D',(#${id})`))).toBe(true);
      expect(representations.some((r) => r.includes(`'FootPrint','Curve2D',(#${base})`))).toBe(true);
      expect(/\.DISCONTINUOUS\./.test(step.get(refs(args).at(-2)!)!.args)).toBe(true);
    }
    // The unprofiled alignment keeps §11's single horizontal Axis representation.
    expect(representations.filter((r) => r.includes("'Axis','Curve2D'"))).toHaveLength(1);
  });

  it('scales stations by the linear unit and elevations by the elevation unit, independently', () => {
    const feet = 0.3048;
    const source: LandXmlIfcSource = {
      schema: 'LandXML-1.2', version: '1.2', surfaces: [],
      units: { ...METRES, linearUnit: 'foot', linearScaleToMeters: feet },
      alignments: [lineAlignment(1000 / feet, 100)],
      profiles: [designProfile([[100, 10], [400, 13], [700, 10]], [{ at: 1, kind: 'parabolic', length: 200 }])],
    };
    const segments = verticalLayouts(parseStep(exported(source))).get('P')!;
    expect(segments.map((s) => s.type)).toEqual(['CONSTANTGRADIENT', 'PARABOLICARC', 'CONSTANTGRADIENT', 'CONSTANTGRADIENT']);
    // Station 100 ft is staStart: distance 0. Curve from station 300 ft to 500 ft.
    expect(segments[0].d).toBe(0);
    expect(segments[1].d).toBeCloseTo(200 * feet, 12);
    expect(segments[1].L).toBeCloseTo(200 * feet, 12);
    // Elevations are metres already; the gradient is metres over metres.
    expect(segments[0].g0).toBeCloseTo(3 / (300 * feet), 12);
    expect(heightAt(segments, 600 * feet)).toBeCloseTo(10, 9);
  });
});

// --- Refusals (§12.2, §12.5): one per reason, each named in the report. ---

function lineAlignment(length = 500, staStart = 1000, extra: Partial<LandXmlIfcAlignment> = {}): LandXmlIfcAlignment {
  return {
    sourceId: 'landxml:alignment:1:L', name: 'L', staStart,
    segments: [{
      sourceId: 's0', ordinal: 0,
      primitive: {
        kind: 'line', start: { kind: 'coordinates', point: { northing: 0, easting: 0 } },
        end: { kind: 'coordinates', point: { northing: 0, easting: length } }, declaredLength: length,
      },
    }],
    ...extra,
  };
}

interface CurveSpec { at: number; kind: string; length?: number; lengthIn?: number; lengthOut?: number; radius?: number }

function designProfile(
  pvis: Array<[number, number | null]>, curves: CurveSpec[] = [], overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sourceId: 'landxml:profile:1:1:design:P', parentAlignmentSourceId: 'landxml:alignment:1:L', ordinal: 1, name: 'P',
    kind: 'design',
    pvis: pvis.map(([station, elevation], index) => ({ sourceId: `pvi:${index}`, station, elevation })),
    verticalCurves: curves.map((curve, index) => ({
      sourceId: `curve:${index}`, kind: curve.kind, station: pvis[curve.at][0], elevation: pvis[curve.at][1],
      length: curve.length ?? null, lengthIn: curve.lengthIn ?? null, lengthOut: curve.lengthOut ?? null,
      radius: curve.radius ?? null,
    })),
    gradeLines: [],
    ...overrides,
  };
}

const GOOD_PVIS: Array<[number, number]> = [[1000, 20], [1200, 24], [1400, 22]];

const REFUSALS: Array<[string, Partial<LandXmlIfcSource>, RegExp]> = [
  ['a malformed record', { profiles: [{}] }, /'profile 1': it is not a profile record/],
  ['a sampled ground profile', { profiles: [designProfile(GOOD_PVIS, [], { kind: 'sampled' })] }, /sampled ground profile \(ProfSurf\)/],
  ['an unlinked profile', { profiles: [designProfile(GOOD_PVIS, [], { parentAlignmentSourceId: 'nowhere' })] }, /not linked to any alignment/],
  ['a profile its alignment does not list', {
    alignments: [lineAlignment(500, 1000, { profileSourceIds: ['landxml:profile:other'] })],
    profiles: [designProfile(GOOD_PVIS)],
  }, /not linked to any alignment/],
  ['two design profiles on one alignment', {
    profiles: [designProfile(GOOD_PVIS), designProfile(GOOD_PVIS, [], { sourceId: 'landxml:profile:1:2:design:Q', name: 'Q' })],
  }, /'P': its alignment 'L' has 2 design profiles.*'Q': its alignment 'L' has 2 design profiles/],
  ['an alignment whose station equations are refused (§14.5)', {
    alignments: [lineAlignment(500, 1000, { stationEquations: [{}] })], profiles: [designProfile(GOOD_PVIS)],
  }, /its alignment 'L' has station equations that are not written, so its stations cannot be placed/],
  ['a profile on a refused alignment', {
    alignments: [{ ...lineAlignment(), segments: [] }], profiles: [designProfile(GOOD_PVIS)],
  }, /its alignment 'L' is not written/],
  ['a single PVI', { profiles: [designProfile([[1000, 20]])] }, /fewer than two PVIs/],
  ['a PVI without an elevation', { profiles: [designProfile([[1000, 20], [1200, null], [1400, 22]])] }, /PVI 2 has no finite station and elevation/],
  ['stations that do not increase', { profiles: [designProfile([[1000, 20], [1300, 24], [1200, 22]])] }, /PVI 3 does not advance/],
  ['a curve at the last PVI', { profiles: [designProfile(GOOD_PVIS, [{ at: 2, kind: 'parabolic', length: 50 }])] }, /not at an interior PVI/],
  ['a curve with no length', { profiles: [designProfile(GOOD_PVIS, [{ at: 1, kind: 'parabolic' }])] }, /length is missing or not positive/],
  ['a curve running past the next PVI', { profiles: [designProfile(GOOD_PVIS, [{ at: 1, kind: 'unsymmetrical_parabolic', lengthIn: 50, lengthOut: 250 }])] }, /ends 50\.000 m past PVI 3/],
  ['overlapping curves', {
    profiles: [designProfile([[1000, 20], [1100, 23], [1200, 21], [1400, 22]], [
      { at: 1, kind: 'parabolic', length: 120 }, { at: 2, kind: 'parabolic', length: 120 },
    ])],
  }, /starts 20\.000 m before the previous one ends/],
  ['a circular curve whose length disagrees with its radius', {
    profiles: [designProfile(GOOD_PVIS, [{ at: 1, kind: 'circular', radius: 2000, length: 90 }])],
  }, /declares a length of 90\.000 m, but its radius and grades give an arc length of/],
  ['a negative (crest) radius on a sag', {
    profiles: [designProfile([[1000, 24], [1200, 20], [1400, 22]], [{ at: 1, kind: 'circular', radius: -2000, length: 60 }])],
  }, /negative \(crest\) radius, but its grades make a sag/],
  ['a circular curve in mixed units', {
    units: { ...METRES, elevationUnit: 'foot', elevationScaleToMeters: 0.3048 },
    profiles: [designProfile(GOOD_PVIS, [{ at: 1, kind: 'circular', radius: 2000, length: 70 }])],
  }, /elevation unit differs from its linear unit/],
  ['a profile running past the end of the alignment', { profiles: [designProfile([[1000, 20], [1600, 24]])] }, /runs from 0\.000 m to 600\.000 m along an alignment 500\.000 m long/],
];

describe('landXmlToIfc — refused profiles are named with their reason (§12.2, §12.5)', () => {
  it.each(REFUSALS)('refuses %s and still writes the alignment', (_label, overrides, reason) => {
    const source: LandXmlIfcSource = {
      schema: 'LandXML-1.2', version: '1.2', units: METRES, surfaces: [], alignments: [lineAlignment()], ...overrides,
    };
    const profiles = collectRefusals(source).find((refusal) => refusal.family === 'profiles');
    expect(profiles?.message).toMatch(reason);
    expect(profiles?.count).toBe(source.profiles?.length);
    const result = landXmlToIfc(source, { timestampMs: 0 });
    if (result.status === 'exported') {
      expect(result.content).not.toContain('IFCALIGNMENTVERTICAL(');
      expect(result.coverage.profiles).toBe(0);
    } else {
      // Only the refused-alignment case has nothing else to write.
      expect(result.reason).toMatch(/alignment/);
    }
  });

  it('does not count an unlinked sibling as a second design profile (#5930 review)', () => {
    // The alignment lists only P. Q names the same parent but is not listed:
    // Q is refused as unlinked, and P alone is written.
    const source: LandXmlIfcSource = {
      schema: 'LandXML-1.2', version: '1.2', units: METRES, surfaces: [],
      alignments: [lineAlignment(500, 1000, { profileSourceIds: ['landxml:profile:1:1:design:P'] })],
      profiles: [designProfile(GOOD_PVIS), designProfile(GOOD_PVIS, [], { sourceId: 'landxml:profile:1:2:design:Q', name: 'Q' })],
    };
    const refused = collectRefusals(source).find((refusal) => refusal.family === 'profiles');
    expect(refused?.count).toBe(1);
    expect(refused?.message).toMatch(/'Q': it is not linked to any alignment/);
    expect(refused?.message).not.toMatch(/design profiles/);
    const result = landXmlToIfc(source, { timestampMs: 0 });
    expect(result.status).toBe('exported');
    if (result.status !== 'exported') return;
    expect(result.content.match(/=IFCALIGNMENTVERTICAL\(/g)).toHaveLength(1);
    expect(result.coverage.profiles).toBe(1);
  });

  it('writes the same profile once its fault is fixed — the refusals above are not a blanket', () => {
    const source: LandXmlIfcSource = {
      schema: 'LandXML-1.2', version: '1.2', units: METRES, surfaces: [], alignments: [lineAlignment()],
      profiles: [designProfile(GOOD_PVIS, [{ at: 1, kind: 'circular', radius: 2000 }].map((curve) => {
        // Horizontal length R·|sin θ2 − sin θ1| for grades +0.02 → −0.01.
        const length = 2000 * Math.abs(Math.sin(Math.atan(-0.01)) - Math.sin(Math.atan(0.02)));
        return { ...curve, length };
      }))],
    };
    expect(collectRefusals(source).find((refusal) => refusal.family === 'profiles')).toBeUndefined();
    const segments = verticalLayouts(parseStep(exported(source))).get('P')!;
    expect(segments.map((s) => s.type)).toEqual(['CONSTANTGRADIENT', 'CIRCULARARC', 'CONSTANTGRADIENT', 'CONSTANTGRADIENT']);
    expect(segments[1].R).toBe(-2000); // a crest
  });

  // 3D-Win's M3 road profile signs its CircCurve radii (negative for a crest)
  // and writes the ARC length; rust/landxml reads the horizontal one (§12.4).
  it.each([
    ['the arc length and a signed crest radius (3D-Win)', -2000, 'arc'],
    ['the horizontal length and an unsigned radius', 2000, 'horizontal'],
  ] as const)('accepts a CircCurve declaring %s', (_label, radius, which) => {
    const t1 = Math.atan(0.02);
    const t2 = Math.atan(-0.01);
    const length = which === 'arc' ? 2000 * Math.abs(t2 - t1) : 2000 * Math.abs(Math.sin(t2) - Math.sin(t1));
    const source: LandXmlIfcSource = {
      schema: 'LandXML-1.2', version: '1.2', units: METRES, surfaces: [], alignments: [lineAlignment()],
      profiles: [designProfile(GOOD_PVIS, [{ at: 1, kind: 'circular', radius, length }])],
    };
    expect(collectRefusals(source).find((refusal) => refusal.family === 'profiles')).toBeUndefined();
    const circle = verticalLayouts(parseStep(exported(source))).get('P')![1];
    expect(circle.type).toBe('CIRCULARARC');
    expect(circle.R).toBe(-2000);
    expect(circle.L).toBeCloseTo(2000 * Math.abs(Math.sin(t2) - Math.sin(t1)), 12);
    // Tangent length R·tan(Δθ/2) back from the PVI at distance 200.
    expect(circle.d).toBeCloseTo(200 - 2000 * Math.tan(Math.abs(t2 - t1) / 2) * Math.cos(t1), 9);
  });
});

// --- #5930 review ---

describe('vertical layout robustness (#5930 review)', () => {
  const straight: HorizontalSegment = {
    sourceId: 'h', type: 'LINE', start: [0, 0], direction: 0, startRadius: 0, endRadius: 0, length: 300,
    end: [300, 0], endDirection: 0, startCurvature: 0, endCurvature: 0,
  };
  const grade = (d: number, L: number, h: number, g: number): VerticalSegment => ({
    sourceId: `v${d}`, type: 'CONSTANTGRADIENT', startDistAlong: d, horizontalLength: L, startHeight: h,
    startGradient: g, endGradient: g, radiusOfCurvature: null,
  });
  const addWith = (segments: VerticalSegment[]) => new IfcCreator({ Schema: 'IFC4X3', Name: 'v', LengthUnit: 'METRE' })
    .terrain().addAlignment({ Name: 'V', StartStation: 0, Segments: [straight], Vertical: { Segments: segments } });

  it('refuses a mid-layout gap through the creator API, as the horizontal emitter does', () => {
    expect(() => addWith([grade(0, 100, 10, 0.01), grade(100.5, 100, 11, 0.01)]))
      .toThrow(/vertical segment 2 starts 0\.500 m along and 0\.000 m in height from where segment 1 ends/);
    expect(() => addWith([grade(0, 100, 10, 0.01), grade(100, 100, 11.2, 0.01)]))
      .toThrow(/vertical segment 2 starts 0\.000 m along and 0\.200 m in height/);
    expect(() => addWith([grade(0, 100, 10, 0.01), grade(100, 100, 11, 0.02)])).not.toThrow();
  });

  it('writes a "curve" between grades equal up to rounding as the straight grade', () => {
    // Grades (20.2 − 20.1)/100 and (20.3 − 20.2)/100 differ by 3.5e-17.
    const source: LandXmlIfcSource = {
      schema: 'LandXML-1.2', version: '1.2', units: METRES, surfaces: [], alignments: [lineAlignment(500, 0)],
      profiles: [designProfile([[0, 20.1], [100, 20.2], [200, 20.3]], [{ at: 1, kind: 'parabolic', length: 80 }])],
    };
    const content = exported(source);
    const segments = verticalLayouts(parseStep(content)).get('P')!;
    expect(segments.map((s) => s.type)).toEqual(['CONSTANTGRADIENT', 'CONSTANTGRADIENT', 'CONSTANTGRADIENT']);
    expect(content).not.toContain('IFCPOLYNOMIALCURVE(');
  });

  it('measures a near-linear parabola at its true length, not 0', () => {
    const g = (20.2 - 20.1) / 100;
    const C = ((20.3 - 20.2) / 100 - g) / (2 * 80);
    expect(C).not.toBe(0);
    expect(polynomialLength(g, C, 80)).toBeCloseTo(80 * Math.sqrt(1 + g * g), 9);
    // And the closed form is still used where it is well conditioned.
    const B = 0.02;
    const K = -0.0001875;
    const exact = (u: number) => (u * Math.sqrt(1 + u * u) + Math.asinh(u)) / 2;
    expect(polynomialLength(B, K, 80)).toBeCloseTo((exact(B + 2 * K * 80) - exact(B)) / (2 * K), 9);
  });
});

