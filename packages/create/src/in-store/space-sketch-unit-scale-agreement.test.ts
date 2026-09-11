/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `storeyPlanFrame` (the space-sketch WRITE side: `useSpaceBake.ts` folds a
 * drawn room through it before authoring) and `existingSpaceFootprintsByStorey`
 * (the READ side: the same hook reads existing spaces back through it to
 * dedup against) must agree on whether a storey's length-unit scale can be
 * trusted. Both derive the scale from the SAME store via the SAME
 * `extractLengthUnitScale` export, so a degenerate result (thrown, zero,
 * negative, `NaN`) must be refused identically on both sides — not refused
 * on one and silently accepted (and used to scale real footprint
 * coordinates to zero) on the other. See #4500 / #4503's module doc: two
 * copies of the same fold that disagree put the read side and the write
 * side on coordinates that differ.
 *
 * `extractLengthUnitScale` itself never returns a degenerate value (see
 * `resolve-anchor-zero-scale.test.ts`), so this pins the guard the same way
 * that test does: by mocking the export directly.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@ifc-lite/parser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ifc-lite/parser')>();
  return {
    ...actual,
    extractLengthUnitScale: () => 0,
  };
});

const { IfcParser } = await import('@ifc-lite/parser');
const { storeyPlanFrame } = await import('./storey-plan-frame.js');
const { existingSpaceFootprintsByStorey } = await import('./extract-walls.js');

/**
 * A storey with a REAL, resolvable placement chain (so `storeyPlanFrame`
 * would succeed on a healthy scale — its refusal below is caused ONLY by
 * the mocked zero scale, not by an unrelated chain defect) and one
 * `IfcSpace` with a real footprint representation (so, pre-fix,
 * `existingSpaceFootprintsByStorey`'s `?? 1` guard would let the zero scale
 * through and still populate an entry — collapsed to the origin — rather
 * than omitting the storey the way a `null`/refused scale should).
 */
const ifc = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0PROJECT000000000000',$,'Proj',$,$,$,$,(#7),#8);
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#9,$);
#9=IFCAXIS2PLACEMENT3D(#90,$,$);
#90=IFCCARTESIANPOINT((0.,0.,0.));
#8=IFCUNITASSIGNMENT((#81));
#81=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#2=IFCSITE('0SITE0000000000000000',$,'Site',$,$,#11,$,$,.ELEMENT.,$,$,$,$,$);
#11=IFCLOCALPLACEMENT($,#12);
#12=IFCAXIS2PLACEMENT3D(#91,$,$);
#91=IFCCARTESIANPOINT((0.,0.,0.));
#3=IFCBUILDING('0BUILDING000000000000',$,'Bldg',$,$,#13,$,$,.ELEMENT.,$,$,$);
#13=IFCLOCALPLACEMENT(#11,#14);
#14=IFCAXIS2PLACEMENT3D(#92,$,$);
#92=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCBUILDINGSTOREY('0STOREY00000000000000',$,'Storey',$,$,#10,$,$,.ELEMENT.,0.);
#10=IFCLOCALPLACEMENT(#13,#15);
#15=IFCAXIS2PLACEMENT3D(#94,$,$);
#94=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCSPACE('0SPACE000000000000000',$,'Room',$,$,#26,#66,$,.ELEMENT.,.INTERNAL.,$);
#26=IFCLOCALPLACEMENT(#13,#27);
#27=IFCAXIS2PLACEMENT3D(#96,$,#97);
#96=IFCCARTESIANPOINT((0.,0.,0.));
#97=IFCDIRECTION((1.,0.,0.));
#66=IFCPRODUCTDEFINITIONSHAPE($,$,(#67));
#67=IFCSHAPEREPRESENTATION(#7,'Body','SweptSolid',(#68));
#68=IFCEXTRUDEDAREASOLID(#69,#75,#76,3.);
#69=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#70);
#70=IFCPOLYLINE((#71,#72,#73,#74));
#71=IFCCARTESIANPOINT((1.,0.));
#72=IFCCARTESIANPOINT((3.,0.));
#73=IFCCARTESIANPOINT((3.,2.));
#74=IFCCARTESIANPOINT((1.,2.));
#75=IFCAXIS2PLACEMENT3D(#98,$,$);
#98=IFCCARTESIANPOINT((0.,0.,0.));
#76=IFCDIRECTION((0.,0.,1.));
#77=IFCRELAGGREGATES('0RELAGG0000000000000',$,$,$,#2,(#3));
#78=IFCRELAGGREGATES('0RELAGG0000000000001',$,$,$,#3,(#4));
#80=IFCRELAGGREGATES('0RELAGG0000000000002',$,$,$,#4,(#6));
ENDSEC;
END-ISO-10303-21;
`;

async function parse() {
  return await new IfcParser().parseColumnar(new TextEncoder().encode(ifc).buffer);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('space-sketch round-trip: degenerate length-unit scale', () => {
  it('storeyPlanFrame refuses on a zero scale', async () => {
    const store = await parse();
    expect(storeyPlanFrame(store, 4)).toBeNull();
  });

  it('existingSpaceFootprintsByStorey refuses the SAME storey the same way, instead of returning a footprint scaled to zero', async () => {
    const store = await parse();
    const byStorey = existingSpaceFootprintsByStorey(store);
    // Not `[[[0, 0], [0, 0], [0, 0], [0, 0]]]` — the old `?? 1` guard would
    // have let the mocked zero scale multiply every real coordinate down to
    // the origin and still returned it as a confident footprint. Refusing
    // must mean "no entry for this storey", the same shape `storeyPlanFrame`
    // already contracts (`storeys with no resolvable space footprints are
    // omitted`), not a degenerate value dressed up as data.
    expect(byStorey.has(4)).toBe(false);
    expect(byStorey.size).toBe(0);
  });
});
