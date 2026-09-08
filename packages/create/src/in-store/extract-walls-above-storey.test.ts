/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #3003. A wall need not hang off its storey's placement. Authoring tools that
 * place every element against one common frame give the wall a
 * `PlacementRelTo` that joins the spatial chain ABOVE the storey — at the
 * building's placement, or at the site's — while still declaring the wall
 * CONTAINED in the storey. `ara3d/ISSUE_034_HouseZ.ifc` in the fixture corpus
 * does exactly this: all 140 of its walls are placed relative to the site
 * placement (#21) while being contained in "Ground Floor" (#45), "First Floor"
 * (#200) and "Roof" (#231).
 *
 * For such a wall the composing walk has nothing to compose — its first parent
 * is already in the storey's own chain — so the frame it returns is expressed
 * in that shared ancestor, not in the storey. Every caller reads it as
 * storey-local: `generateSpacesFromWalls` hands the segments to
 * `addSpaceToStore`, which authors the space with the storey placement as its
 * `PlacementRelTo`, so the storey's own offset and rotation get applied to
 * coordinates that never had them removed.
 *
 * Getting the direction of that removal wrong moves every affected wall
 * silently, so this fixture rotates the storey as well as offsetting it: an
 * inverse applied the wrong way round lands on different numbers than the ones
 * pinned below, instead of on a sign flip that a translation-only fixture would
 * miss.
 *
 * Frames, all planar (this extractor carries X/Y and a ground-plane direction;
 * elevation is not part of a `PlacementFrame`):
 *
 *   site #11      identity
 *   building #13  origin (10, 20) relative to the site
 *   storey #10    origin (100, 200), RefDirection (0, 1) relative to the
 *                 building — so the storey frame is the building frame rotated
 *                 90° CCW about +Z and moved to (110, 220) in the world.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { extractWallSegmentsForStorey } from './extract-walls.js';

// #50 wall — the ordinary shape: PlacementRelTo = #10, the storey itself.
// #56 wall — PlacementRelTo = #13, the BUILDING placement (one hop above).
// #58 wall — PlacementRelTo = #11, the SITE placement (two hops above).
// All three are contained in storey #4 and carry the same (0,0)→(5,0) axis.
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
#92=IFCCARTESIANPOINT((10.,20.,0.));
#4=IFCBUILDINGSTOREY('0STOREY00000000000000',$,'Storey',$,$,#10,$,$,.ELEMENT.,0.);
#10=IFCLOCALPLACEMENT(#13,#15);
#15=IFCAXIS2PLACEMENT3D(#93,$,#16);
#93=IFCCARTESIANPOINT((100.,200.,0.));
#16=IFCDIRECTION((0.,1.,0.));
#50=IFCWALL('0WALL0000000000000000',$,'Direct',$,$,#20,#60,$,$);
#20=IFCLOCALPLACEMENT(#10,#21);
#21=IFCAXIS2PLACEMENT3D(#94,$,#95);
#94=IFCCARTESIANPOINT((0.,0.,0.));
#95=IFCDIRECTION((1.,0.,0.));
#56=IFCWALL('0WALL0000000000000003',$,'OnBuilding',$,$,#26,#60,$,$);
#26=IFCLOCALPLACEMENT(#13,#27);
#27=IFCAXIS2PLACEMENT3D(#104,$,#105);
#104=IFCCARTESIANPOINT((0.,0.,0.));
#105=IFCDIRECTION((1.,0.,0.));
#58=IFCWALL('0WALL0000000000000004',$,'OnSite',$,$,#28,#60,$,$);
#28=IFCLOCALPLACEMENT(#11,#29);
#29=IFCAXIS2PLACEMENT3D(#106,$,#107);
#106=IFCCARTESIANPOINT((0.,0.,0.));
#107=IFCDIRECTION((1.,0.,0.));
#60=IFCPRODUCTDEFINITIONSHAPE($,$,(#61));
#61=IFCSHAPEREPRESENTATION(#7,'Axis','Curve2D',(#62));
#62=IFCPOLYLINE((#63,#64));
#63=IFCCARTESIANPOINT((0.,0.));
#64=IFCCARTESIANPOINT((5.,0.));
#70=IFCRELAGGREGATES('0RELAGG0000000000000',$,$,$,#2,(#3));
#71=IFCRELAGGREGATES('0RELAGG0000000000001',$,$,$,#3,(#4));
#72=IFCRELCONTAINEDINSPATIALSTRUCTURE('0RELCONT000000000000',$,$,$,(#50,#56,#58),#4);
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

describe('extractWallSegmentsForStorey: placements that join above the storey', () => {
  it('does not move a wall placed directly under the storey', async () => {
    const byWall = await segmentsByWall();
    // The control. Its parent IS the storey placement, so nothing is composed
    // and nothing is removed: the wall's own frame is already storey-local.
    expect(byWall.get(50)).toEqual({ a: [0, 0], b: [5, 0] });
  });

  it('expresses a wall placed on the building placement in the storey frame', async () => {
    const byWall = await segmentsByWall();
    // The wall sits at the building origin, axis +X. The storey is that same
    // building frame rotated 90° CCW and moved to (100, 200), so storey-local
    // = Rᵀ(p − (100, 200)) with R = [[0,−1],[1,0]]:
    //   (0, 0) → (−200, 100)   (5, 0) → (−200, 95)
    // Composing nothing (the pre-fix behaviour) leaves it at (0,0)→(5,0), and
    // applying the storey frame instead of its inverse gives (100,200)→(100,205).
    expect(byWall.get(56)).toEqual({ a: [-200, 100], b: [-200, 95] });
  });

  it('composes both hops for a wall placed on the site placement', async () => {
    const byWall = await segmentsByWall();
    // Two hops of the storey's own chain have to be removed now, not one: the
    // storey sits at (110, 220) in the site frame. Storey-local of the site
    // origin is Rᵀ(−110, −220) = (−220, 110), and the +X axis maps to (0, −1).
    expect(byWall.get(58)).toEqual({ a: [-220, 110], b: [-220, 105] });
  });

  it('leaves the wall where it is when a storey-chain frame is unreadable', async () => {
    // The building placement #13 loses its `RelativePlacement`, so the storey's
    // frame relative to the site cannot be computed. Removing only the part of
    // the chain that IS readable would move the wall by a partial transform,
    // which is worse than not correcting: the wall stays at its own frame,
    // exactly what this returned before #3003.
    const broken = ifc.replace('#13=IFCLOCALPLACEMENT(#11,#14);', '#13=IFCLOCALPLACEMENT(#11,$);');
    expect(broken).toContain('#13=IFCLOCALPLACEMENT(#11,$);');
    const parser = new IfcParser();
    const store = await parser.parseColumnar(new TextEncoder().encode(broken).buffer);
    const result = extractWallSegmentsForStorey(store, 4);
    const i = result.contributingWallIds.indexOf(58);
    expect(i).toBeGreaterThanOrEqual(0);
    const s = result.segments[i];
    expect([
      [s.a[0], s.a[1]],
      [s.b[0], s.b[1]],
    ]).toEqual([
      [0, 0],
      [5, 0],
    ]);
  });
});
