/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the LandXML→IFC v1 converter (`docs/architecture/landxml-to-ifc-mapping.md`).
 *
 * Fixtures are built directly against `source-types.ts`, not parsed from XML —
 * this module is deliberately testable without a LandXML parser (see that
 * file's header comment). Every fixture that is meant to export uses
 * asymmetric northing/easting values on purpose: a square or symmetric point
 * set produces the same triangle whether or not the axes are swapped, which
 * is exactly the failure mode §2.2 warns about (a transposed export passes
 * every count-based and every symmetric-coordinate assertion).
 */

import { describe, it, expect } from 'vitest';
import { isValidIfcGuid } from '@ifc-lite/encoding';
import { num } from '../ifc-creator-math.js';
import {
  landXmlToIfc, landXmlGlobalId, LANDXML_IFC_MAPPING_VERSION,
} from './landxml-to-ifc.js';
import type { LandXmlIfcOptions } from './landxml-to-ifc.js';
import type {
  LandXmlIfcCgPoint, LandXmlIfcPoint, LandXmlIfcSource, LandXmlIfcSurface, LandXmlIfcUnits,
} from './source-types.js';
import type { LandXmlIfcResult } from './result-types.js';

// ---------------------------------------------------------------------------
// Fixture builders. Kept small and explicit rather than deeply generic, so a
// reader can see the authored values a test is asserting against without
// chasing them through override layers.
// ---------------------------------------------------------------------------

function metreUnits(overrides: Partial<LandXmlIfcUnits> = {}): LandXmlIfcUnits {
  return {
    linearUnit: 'metre',
    elevationUnit: 'metre',
    linearScaleToMeters: 1,
    elevationScaleToMeters: 1,
    assumed: false,
    ...overrides,
  };
}

/** A triangle whose northing and easting value sets are disjoint (100s vs 20-30s). */
const ASYMMETRIC_TRIANGLE_POINTS: LandXmlIfcPoint[] = [
  {
    sourceId: 'landxml:surface:1:point:1', id: 'p1', northing: 100, easting: 20, elevation: 5,
  },
  {
    sourceId: 'landxml:surface:1:point:2', id: 'p2', northing: 140, easting: 25, elevation: 6,
  },
  {
    sourceId: 'landxml:surface:1:point:3', id: 'p3', northing: 105, easting: 30, elevation: 7,
  },
];
const ASYMMETRIC_TRIANGLE_FACES: Array<[string, string, string]> = [['p1', 'p2', 'p3']];

function mappableSurface(overrides: Partial<LandXmlIfcSurface> = {}): LandXmlIfcSurface {
  return {
    sourceId: 'landxml:surface:1',
    name: 'Existing Ground',
    kind: 'existing ground',
    renderState: 'rendered',
    points: ASYMMETRIC_TRIANGLE_POINTS,
    faces: ASYMMETRIC_TRIANGLE_FACES,
    ...overrides,
  };
}

function minimalSource(overrides: Partial<LandXmlIfcSource> = {}): LandXmlIfcSource {
  return {
    schema: 'LandXML',
    version: '1.2',
    units: metreUnits(),
    surfaces: [mappableSurface()],
    ...overrides,
  };
}

/** Narrows a result to the `exported` branch, asserting the branch as a side effect. */
function expectExported(
  result: LandXmlIfcResult,
): asserts result is Extract<LandXmlIfcResult, { status: 'exported' }> {
  expect(result.status).toBe('exported');
}

/** Narrows a result to the `refused` branch, asserting the branch as a side effect. */
function expectRefused(
  result: LandXmlIfcResult,
): asserts result is Extract<LandXmlIfcResult, { status: 'refused' }> {
  expect(result.status).toBe('refused');
}

describe('landXmlToIfc — axis order (§2.2)', () => {
  // This is the single most important test in this file. LandXML <P> text is
  // authored northing-easting-elevation; IFC CoordList is (X,Y,Z) =
  // (easting,northing,elevation). If `toIfcVertex` ever writes
  // [northing, easting] instead of [easting, northing], this is the test that
  // catches it — and it is what stands between the repo and a silently
  // mirrored terrain, because a transposed mesh is still well-formed, still
  // renders, and still passes every vertex/triangle COUNT assertion.
  it('writes IfcCartesianPointList3D as (easting, northing, elevation), not (northing, easting, elevation)', () => {
    const result = landXmlToIfc(minimalSource());
    expectExported(result);

    const expectedCoordList = `IFCCARTESIANPOINTLIST3D(((${num(20)},${num(100)},${num(5)}),`
      + `(${num(25)},${num(140)},${num(6)}),(${num(30)},${num(105)},${num(7)})),$)`;
    expect(result.content).toContain(expectedCoordList);
    // The wrong-order string must NOT appear — belt and suspenders against a
    // false pass from a coincidental substring match elsewhere in the file.
    const mirroredCoordList = `IFCCARTESIANPOINTLIST3D(((${num(100)},${num(20)},${num(5)}),`
      + `(${num(140)},${num(25)},${num(6)}),(${num(105)},${num(30)},${num(7)})),$)`;
    expect(result.content).not.toContain(mirroredCoordList);
  });

  // Same defect, different carrier: a survey point's placement uses the same
  // `toIfcVertex`, and its IfcCartesianPoint must show the same axis order.
  it('writes a survey point IfcCartesianPoint as (easting, northing, elevation)', () => {
    const cgPoint: LandXmlIfcCgPoint = {
      sourceId: 'landxml:cgpoint:1',
      name: null,
      code: null,
      description: null,
      point: { northing: 333, easting: 77, elevation: 9.5 },
    };
    const source = minimalSource({ surfaces: [], plan: { cogoPoints: [cgPoint] } });
    const result = landXmlToIfc(source);
    expectExported(result);

    expect(result.content).toContain(`IFCCARTESIANPOINT((${num(77)},${num(333)},${num(9.5)}))`);
    expect(result.content).not.toContain(`IFCCARTESIANPOINT((${num(333)},${num(77)},${num(9.5)}))`);
  });
});

describe('landXmlToIfc — units (§2.1)', () => {
  // Plan scale and elevation scale differ (LandXML permits a distinct unit for
  // elevation than for the plan axes). A test using EQUAL scales cannot catch
  // the mistake of applying `linearScaleToMeters` to elevation too — this one
  // is built so that mistake produces a different, wrong number (2, not 10).
  it('applies linearScaleToMeters to X/Y and elevationScaleToMeters to Z, independently', () => {
    const units = metreUnits({
      linearUnit: 'foot', elevationUnit: 'metre', linearScaleToMeters: 2, elevationScaleToMeters: 10,
    });
    const points: LandXmlIfcPoint[] = [
      {
        sourceId: 'landxml:surface:1:point:1', id: 'p1', northing: 3, easting: 4, elevation: 1,
      },
      {
        sourceId: 'landxml:surface:1:point:2', id: 'p2', northing: 5, easting: 6, elevation: 2,
      },
      {
        sourceId: 'landxml:surface:1:point:3', id: 'p3', northing: 7, easting: 8, elevation: 3,
      },
    ];
    const source = minimalSource({
      units,
      surfaces: [mappableSurface({ points, faces: [['p1', 'p2', 'p3']] })],
    });
    const result = landXmlToIfc(source);
    expectExported(result);

    // (X,Y,Z) = (easting*2, northing*2, elevation*10). If elevation were
    // scaled by the plan factor instead, Z would read 2/4/6, not 10/20/30.
    const expectedCoordList = `IFCCARTESIANPOINTLIST3D(((${num(8)},${num(6)},${num(10)}),`
      + `(${num(12)},${num(10)},${num(20)}),(${num(16)},${num(14)},${num(30)})),$)`;
    expect(result.content).toContain(expectedCoordList);
  });

  // Units.null is the "LandXML declares no numeric unit at all" case (§2.1) —
  // distinct from the assumed-unit case below, which does declare a scale,
  // just not one read from the file.
  it('refuses a source with units: null, even though it carries a mappable surface', () => {
    const result = landXmlToIfc(minimalSource({ units: null }));
    expectRefused(result);
  });

  it('units.assumed: true warns LXIFC-ASSUMED-UNIT and records provenance.assumedLinearUnit; assumed: false does neither', () => {
    const assumedResult = landXmlToIfc(minimalSource({
      units: metreUnits({ assumed: true, linearUnit: 'US survey foot' }),
    }));
    const declaredResult = landXmlToIfc(minimalSource({
      units: metreUnits({ assumed: false }),
    }));
    expectExported(assumedResult);
    expectExported(declaredResult);

    expect(assumedResult.warnings.some((w) => w.code === 'LXIFC-ASSUMED-UNIT')).toBe(true);
    expect(assumedResult.provenance.assumedLinearUnit).toBe('US survey foot');

    expect(declaredResult.warnings.some((w) => w.code === 'LXIFC-ASSUMED-UNIT')).toBe(false);
    expect(declaredResult.provenance.assumedLinearUnit).toBeNull();
  });
});

describe('landXmlToIfc — refusal as an outcome (§6, §9.4)', () => {
  // §9.4: an alignment-only file must refuse outright, naming what it holds,
  // rather than silently producing a valid, empty, useless IFC.
  it('refuses an alignment-only source, naming the alignments and their count, and returns no content', () => {
    const source = minimalSource({ surfaces: [], alignments: [{}, {}, {}] });
    const result = landXmlToIfc(source);
    expectRefused(result);

    expect(result.reason).toContain('3 alignments');
    // The refused branch of the discriminated union carries no `content` key
    // at all — this is the "not an empty IFC" assertion, not just a status check.
    expect('content' in result).toBe(false);
  });

  it('refuses a source whose every surface is renderState: preserved_only', () => {
    const source = minimalSource({
      surfaces: [mappableSurface({ renderState: 'preserved_only' })],
    });
    const result = landXmlToIfc(source);
    expectRefused(result);

    expect(result.refusals.some((r) => r.family === 'non-rendered-surfaces' && r.count === 1)).toBe(true);
    expect(result.reason).toContain('1 non rendered surfaces');
  });

  // A "rendered" surface whose every face is hidden writes no triangles.
  // Being the only record in the source, this must refuse — not export a
  // TIN with zero surfaces and call it done.
  it('writes no surface when a rendered surface has every face hidden, and refuses when that is the only record', () => {
    const source = minimalSource({
      surfaces: [mappableSurface({ faceVisibility: [false] })],
    });
    const result = landXmlToIfc(source);
    expectRefused(result);
    expect(result.reason).toContain('no triangulated surface and no CgPoints');
  });

  // A partial source — one mappable surface alongside out-of-scope families —
  // must still export, with those families named in `refusals`, per §6's "no
  // silent partial" rule.
  it('exports a partial source, listing both out-of-scope families it also carries', () => {
    const source = minimalSource({
      alignments: [{}, {}],
      plan: { parcels: [{}, {}, {}] },
    });
    const result = landXmlToIfc(source);
    expectExported(result);

    expect(result.refusals.some((r) => r.family === 'alignments' && r.count === 2)).toBe(true);
    expect(result.refusals.some((r) => r.family === 'parcels' && r.count === 3)).toBe(true);
  });
});

describe('landXmlToIfc — determinism (§8.4)', () => {
  it('produces byte-identical content across two conversions of the same source with the same timestampMs', () => {
    const source = minimalSource({ surfaces: [mappableSurface({ sourceId: 'landxml:surface:A' })] });
    const options: LandXmlIfcOptions = { sourceFileName: 'det.xml', timestampMs: 1_700_000_000_000 };

    const first = landXmlToIfc(source, options);
    const second = landXmlToIfc(source, options);
    expectExported(first);
    expectExported(second);

    expect(first.content).toBe(second.content);
  });

  // Determinism must be a function of the SOURCE, not a constant the creator
  // always emits — two sources differing only in a surface's sourceId must
  // still diverge on that surface's GlobalId.
  it('gives two sources differing only in a surface sourceId different GlobalIds', () => {
    const options: LandXmlIfcOptions = { sourceFileName: 'det.xml', timestampMs: 1_700_000_000_000 };
    const sourceA = minimalSource({ surfaces: [mappableSurface({ sourceId: 'landxml:surface:A' })] });
    const sourceB = minimalSource({ surfaces: [mappableSurface({ sourceId: 'landxml:surface:B' })] });

    const resultA = landXmlToIfc(sourceA, options);
    const resultB = landXmlToIfc(sourceB, options);
    expectExported(resultA);
    expectExported(resultB);

    const guidA = /IFCGEOGRAPHICELEMENT\('([^']+)'/.exec(resultA.content)?.[1];
    const guidB = /IFCGEOGRAPHICELEMENT\('([^']+)'/.exec(resultB.content)?.[1];
    expect(guidA).toBeDefined();
    expect(guidB).toBeDefined();
    expect(guidA).not.toBe(guidB);
  });
});

describe('landXmlGlobalId (§4.3)', () => {
  it('is stable, 22 characters, and a valid IFC GlobalId', () => {
    const guid1 = landXmlGlobalId('landxml:surface:3');
    const guid2 = landXmlGlobalId('landxml:surface:3');
    const otherGuid = landXmlGlobalId('landxml:surface:3:point:41');

    expect(guid1).toBe(guid2);
    expect(guid1).toHaveLength(22);
    expect(isValidIfcGuid(guid1)).toBe(true);
    expect(isValidIfcGuid(otherGuid)).toBe(true);
    expect(guid1).not.toBe(otherGuid);
  });
});

describe('landXmlToIfc — provenance (§7)', () => {
  it('records the LandXML_Conversion property set on IfcSite with mapping version, source, units, assumption, swap and refused families', () => {
    const source = minimalSource({ alignments: [{}, {}] });
    const options: LandXmlIfcOptions = { sourceFileName: 'sample.xml', crs: { Name: 'Test CRS' } };
    const result = landXmlToIfc(source, options);
    expectExported(result);

    expect(result.provenance.mappingVersion).toBe(LANDXML_IFC_MAPPING_VERSION);
    expect(result.provenance.landXmlSchema).toBe('LandXML');
    expect(result.provenance.sourceFileName).toBe('sample.xml');
    expect(result.provenance.assumedLinearUnit).toBeNull();
    expect(result.provenance.coordinateOrderSwapped).toBe(false);
    expect(result.provenance.refusedFamilies).toContain('alignments');

    // Asserted directly against the produced STEP text, not just the returned
    // object, because the pset is what a downstream IFC-only consumer sees.
    expect(result.content).toContain("'LandXML_Conversion'");
    expect(result.content).toContain(`IFCPROPERTYSINGLEVALUE('MappingVersion',$,IFCLABEL('${LANDXML_IFC_MAPPING_VERSION}'),$)`);
    expect(result.content).toContain("IFCPROPERTYSINGLEVALUE('LandXmlSchema',$,IFCLABEL('LandXML'),$)");
    expect(result.content).toContain("IFCPROPERTYSINGLEVALUE('SourceFileName',$,IFCLABEL('sample.xml'),$)");
    expect(result.content).toContain("IFCPROPERTYSINGLEVALUE('LinearUnit',$,IFCLABEL('metre'),$)");
    expect(result.content).toContain("IFCPROPERTYSINGLEVALUE('ElevationUnit',$,IFCLABEL('metre'),$)");
    expect(result.content).toContain("IFCPROPERTYSINGLEVALUE('AssumedLinearUnit',$,IFCLABEL(''),$)");
    expect(result.content).toContain("IFCPROPERTYSINGLEVALUE('CoordinateOrderSwapped',$,IFCLABEL('false'),$)");
    expect(result.content).toContain("IFCPROPERTYSINGLEVALUE('RefusedRecordFamilies',$,IFCLABEL('alignments'),$)");
  });
});

describe('landXmlToIfc — coordinate-order override (§2.2 item 2)', () => {
  // Models an operator-confirmed easting-first producer: the values the
  // parser bound into the `northing`/`easting` fields are transposed relative
  // to a correctly-read source, and `swapNorthingEasting: true` is the
  // operator's assertion that undoes it. The two sources below must produce
  // the same IFC coordinates.
  it('makes an easting-first source with swapNorthingEasting: true match the equivalent northing-first source, and warns LXIFC-COORD-SWAPPED', () => {
    const correctlyReadPoints: LandXmlIfcPoint[] = [
      {
        sourceId: 'landxml:surface:1:point:1', id: 'a', northing: 500, easting: 60, elevation: 1,
      },
      {
        sourceId: 'landxml:surface:1:point:2', id: 'b', northing: 510, easting: 65, elevation: 2,
      },
      {
        sourceId: 'landxml:surface:1:point:3', id: 'c', northing: 505, easting: 70, elevation: 3,
      },
    ];
    // Same physical points, but read by a parser that trusted the (buggy)
    // easting-first text: what lands in the `northing` field is the true
    // easting, and vice versa.
    const mislabeledPoints: LandXmlIfcPoint[] = [
      {
        sourceId: 'landxml:surface:1:point:1', id: 'a', northing: 60, easting: 500, elevation: 1,
      },
      {
        sourceId: 'landxml:surface:1:point:2', id: 'b', northing: 65, easting: 510, elevation: 2,
      },
      {
        sourceId: 'landxml:surface:1:point:3', id: 'c', northing: 70, easting: 505, elevation: 3,
      },
    ];
    const faces: Array<[string, string, string]> = [['a', 'b', 'c']];

    const unswappedResult = landXmlToIfc(minimalSource({
      surfaces: [mappableSurface({ points: correctlyReadPoints, faces })],
    }));
    const swappedResult = landXmlToIfc(minimalSource({
      surfaces: [mappableSurface({ points: mislabeledPoints, faces })],
    }), { swapNorthingEasting: true });
    expectExported(unswappedResult);
    expectExported(swappedResult);

    const expectedCoordList = `IFCCARTESIANPOINTLIST3D(((${num(60)},${num(500)},${num(1)}),`
      + `(${num(65)},${num(510)},${num(2)}),(${num(70)},${num(505)},${num(3)})),$)`;
    expect(unswappedResult.content).toContain(expectedCoordList);
    expect(swappedResult.content).toContain(expectedCoordList);

    expect(unswappedResult.warnings.some((w) => w.code === 'LXIFC-COORD-SWAPPED')).toBe(false);
    expect(swappedResult.warnings.some((w) => w.code === 'LXIFC-COORD-SWAPPED')).toBe(true);
  });
});

describe('landXmlToIfc — CRS (§4.2)', () => {
  it('writes no IfcProjectedCRS/IfcMapConversion at all, and warns LXIFC-NO-CRS, when no crs option is given', () => {
    const result = landXmlToIfc(minimalSource());
    expectExported(result);

    expect(result.content).not.toContain('IFCPROJECTEDCRS');
    expect(result.content).not.toContain('IFCMAPCONVERSION');
    expect(result.warnings.some((w) => w.code === 'LXIFC-NO-CRS')).toBe(true);
  });

  it('writes both IfcProjectedCRS and IfcMapConversion, and does not warn LXIFC-NO-CRS, when a crs option is given', () => {
    const result = landXmlToIfc(minimalSource(), { crs: { Name: 'SWEREF99 TM' } });
    expectExported(result);

    expect(result.content).toContain('IFCPROJECTEDCRS');
    expect(result.content).toContain('IFCMAPCONVERSION');
    expect(result.warnings.some((w) => w.code === 'LXIFC-NO-CRS')).toBe(false);
  });
});

describe('landXmlToIfc — face integrity', () => {
  it('throws, naming the surface and the missing point id, when a face references a <P> id the surface does not define', () => {
    const brokenSurface = mappableSurface({
      name: 'Broken Surface',
      points: [
        {
          sourceId: 'landxml:surface:1:point:1', id: 'p1', northing: 0, easting: 0, elevation: 0,
        },
        {
          sourceId: 'landxml:surface:1:point:2', id: 'p2', northing: 10, easting: 10, elevation: 0,
        },
      ],
      faces: [['p1', 'p2', 'p99']],
    });
    const source = minimalSource({ surfaces: [brokenSurface] });

    expect(() => landXmlToIfc(source)).toThrow(/surface 'Broken Surface' face 0 references point id 'p99'/);
  });
});
