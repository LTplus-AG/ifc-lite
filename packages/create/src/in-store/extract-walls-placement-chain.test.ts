/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `extractWallSegmentsForStorey` must express every segment in the STOREY
 * frame — the same frame `generateSpacesFromWalls` authors into, since
 * `addSpaceToStore` emits the new `IfcSpace` with `anchor.storeyPlacementId`
 * as its `PlacementRelTo` (`space.ts`, `resolve-anchor.ts`).
 *
 * Two properties, both observable only because this fixture's storey sits at
 * a NON-ORIGIN placement (100., 200., 0.):
 *
 *  1. Intermediate `IfcLocalPlacement.PlacementRelTo` hops between a wall and
 *     its storey (the standard `IfcElementAssembly` grouping for curtain
 *     walls / precast panels / railing systems) must be composed in. Reading
 *     only the wall's own `RelativePlacement` drops that hop's translation
 *     and rotation, so the member lands at the wrong place relative to
 *     siblings placed directly under the storey.
 *
 *  2. A wall placed directly under the storey must NOT move. Composing on
 *     past the storey to the root would add the storey's own (100, 200)
 *     offset to every segment, and the space generated from those segments
 *     would then be authored 100 m east / 200 m north of the actual room.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { extractWallSegmentsForStorey } from './extract-walls.js';

// Storey #4's own placement #10 is at (100., 200., 0.) relative to the
// building — the offset that makes "storey frame" distinguishable from
// "root frame". Under it:
//   #50 wall  — single hop: PlacementRelTo = #10 (the storey) directly.
//   #52 wall  — two hops: PlacementRelTo = #30 (IfcElementAssembly #40's
//               placement, at (3., 4., 0.) in the storey frame).
//   #54 wall  — two hops through a ROTATED assembly #42 at (3., 4., 0.)
//               with RefDirection (0., 1., 0.), own origin (1., 0.).
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
#81=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
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
#15=IFCAXIS2PLACEMENT3D(#93,$,$);
#93=IFCCARTESIANPOINT((100.,200.,0.));
#50=IFCWALL('0WALL0000000000000000',$,'Direct',$,$,#20,#60,$,$);
#20=IFCLOCALPLACEMENT(#10,#21);
#21=IFCAXIS2PLACEMENT3D(#94,$,#95);
#94=IFCCARTESIANPOINT((0.,0.,0.));
#95=IFCDIRECTION((1.,0.,0.));
#40=IFCELEMENTASSEMBLY('0ASSEMBLY000000000000',$,'Asm',$,$,#30,$,$,$,.NOTDEFINED.);
#30=IFCLOCALPLACEMENT(#10,#31);
#31=IFCAXIS2PLACEMENT3D(#96,$,#97);
#96=IFCCARTESIANPOINT((3.,4.,0.));
#97=IFCDIRECTION((1.,0.,0.));
#52=IFCWALL('0WALL0000000000000001',$,'Nested',$,$,#22,#60,$,$);
#22=IFCLOCALPLACEMENT(#30,#23);
#23=IFCAXIS2PLACEMENT3D(#98,$,#99);
#98=IFCCARTESIANPOINT((0.,0.,0.));
#99=IFCDIRECTION((1.,0.,0.));
#42=IFCELEMENTASSEMBLY('0ASSEMBLY000000000001',$,'AsmRot',$,$,#32,$,$,$,.NOTDEFINED.);
#32=IFCLOCALPLACEMENT(#10,#33);
#33=IFCAXIS2PLACEMENT3D(#100,$,#101);
#100=IFCCARTESIANPOINT((3.,4.,0.));
#101=IFCDIRECTION((0.,1.,0.));
#54=IFCWALL('0WALL0000000000000002',$,'NestedRot',$,$,#24,#60,$,$);
#24=IFCLOCALPLACEMENT(#32,#25);
#25=IFCAXIS2PLACEMENT3D(#102,$,#103);
#102=IFCCARTESIANPOINT((1.,0.,0.));
#103=IFCDIRECTION((1.,0.,0.));
#60=IFCPRODUCTDEFINITIONSHAPE($,$,(#61));
#61=IFCSHAPEREPRESENTATION(#7,'Axis','Curve2D',(#62));
#62=IFCPOLYLINE((#63,#64));
#63=IFCCARTESIANPOINT((0.,0.));
#64=IFCCARTESIANPOINT((5.,0.));
#70=IFCRELAGGREGATES('0RELAGG0000000000000',$,$,$,#2,(#3));
#71=IFCRELAGGREGATES('0RELAGG0000000000001',$,$,$,#3,(#4));
#72=IFCRELCONTAINEDINSPATIALSTRUCTURE('0RELCONT000000000000',$,$,$,(#50,#40,#42),#4);
#73=IFCRELAGGREGATES('0RELAGG0000000000002',$,$,$,#40,(#52));
#74=IFCRELAGGREGATES('0RELAGG0000000000003',$,$,$,#42,(#54));
ENDSEC;
END-ISO-10303-21;
`;

async function segmentsByWall(): Promise<Map<number, { a: number[]; b: number[] }>> {
  const parser = new IfcParser();
  const buf = new TextEncoder().encode(ifc).buffer;
  const store = await parser.parseColumnar(buf);
  const result = extractWallSegmentsForStorey(store, 4);
  const byWall = new Map<number, { a: number[]; b: number[] }>();
  result.contributingWallIds.forEach((id, i) => {
    const s = result.segments[i];
    byWall.set(id, { a: [s.a[0], s.a[1]], b: [s.b[0], s.b[1]] });
  });
  return byWall;
}

describe('extractWallSegmentsForStorey: PlacementRelTo chain, storey frame', () => {
  it('does not move a wall placed directly under a non-origin storey', async () => {
    const byWall = await segmentsByWall();
    // The storey's own (100, 200) offset must NOT leak in: the authoring
    // side re-anchors the generated space to the storey placement, which
    // would apply that offset a second time.
    expect(byWall.get(50)).toEqual({ a: [0, 0], b: [5, 0] });
  });

  it("composes an assembly's intermediate hop into a nested wall's axis", async () => {
    const byWall = await segmentsByWall();
    // assembly origin (3, 4) + wall-local (0, 0) => (3, 4); axis (1, 0).
    expect(byWall.get(52)).toEqual({ a: [3, 4], b: [8, 4] });
  });

  it("composes a rotated assembly's hop (rotation, not just translation)", async () => {
    const byWall = await segmentsByWall();
    // assembly frame: origin (3, 4), axisX (0, 1). The wall's own origin
    // (1, 0) maps to (3, 5); its axis (1, 0) maps to (0, 1), so b = (3, 10).
    expect(byWall.get(54)).toEqual({ a: [3, 5], b: [3, 10] });
  });
});
