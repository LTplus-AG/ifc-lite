/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcProduct.ObjectPlacement` is OPTIONAL, so a storey may legitimately
 * carry `$` there. The storey-frame chain walk stops composing when it
 * reaches the storey's OWN placement chain — and a storey with no placement
 * has no such chain, so there is nothing to stop on and composition runs on
 * to the world root, handing back WORLD coordinates where the contract (and
 * every caller) says storey-local.
 *
 * Both readers below are reachable with such a storey:
 *  - `extractWallSegmentsForStorey` — the preview path.
 *  - `existingSpaceFootprintsByStorey`, which iterates every
 *    `IfcBuildingStorey` in the store with no anchor resolution at all.
 * Only the non-dry-run authoring path is protected, by `resolveSpatialAnchor`
 * refusing a storey with no resolvable `IfcLocalPlacement`.
 *
 * The site (1000, 2000) and building (100, 200) offsets exist so "composed to
 * the world root" is a different number from "composed nothing" — the wall
 * and the space are placed relative to the BUILDING placement, the nearest
 * one that survives when the storey has none.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { extractWallSegmentsForStorey, existingSpaceFootprintsByStorey } from './extract-walls.js';

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
#91=IFCCARTESIANPOINT((1000.,2000.,0.));
#3=IFCBUILDING('0BUILDING000000000000',$,'Bldg',$,$,#13,$,$,.ELEMENT.,$,$,$);
#13=IFCLOCALPLACEMENT(#11,#14);
#14=IFCAXIS2PLACEMENT3D(#92,$,$);
#92=IFCCARTESIANPOINT((100.,200.,0.));
#4=IFCBUILDINGSTOREY('0STOREY00000000000000',$,'Storey',$,$,$,$,$,.ELEMENT.,0.);
#50=IFCWALL('0WALL0000000000000000',$,'Direct',$,$,#20,#60,$,$);
#20=IFCLOCALPLACEMENT(#13,#21);
#21=IFCAXIS2PLACEMENT3D(#94,$,#95);
#94=IFCCARTESIANPOINT((0.,0.,0.));
#95=IFCDIRECTION((1.,0.,0.));
#60=IFCPRODUCTDEFINITIONSHAPE($,$,(#61));
#61=IFCSHAPEREPRESENTATION(#7,'Axis','Curve2D',(#62));
#62=IFCPOLYLINE((#63,#64));
#63=IFCCARTESIANPOINT((0.,0.));
#64=IFCCARTESIANPOINT((5.,0.));
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
#79=IFCRELCONTAINEDINSPATIALSTRUCTURE('0RELCONT000000000000',$,$,$,(#50),#4);
#80=IFCRELAGGREGATES('0RELAGG0000000000002',$,$,$,#4,(#6));
ENDSEC;
END-ISO-10303-21;
`;

async function parse() {
  return await new IfcParser().parseColumnar(new TextEncoder().encode(ifc).buffer);
}

describe('storey with no ObjectPlacement', () => {
  it('does not compose the site/building offsets into a wall segment', async () => {
    const store = await parse();
    const result = extractWallSegmentsForStorey(store, 4);
    const byWall = new Map(
      result.contributingWallIds.map((id, i) => [
        id,
        [
          [result.segments[i].a[0], result.segments[i].a[1]],
          [result.segments[i].b[0], result.segments[i].b[1]],
        ],
      ]),
    );
    // Composing nothing — the wall's own frame — is what this returned before
    // the storey-frame walk existed. Composing on to the root would give
    // [[1100, 2200], [1105, 2200]]: world coordinates labelled storey-local,
    // which the authoring side would then offset by the storey a second time.
    expect(byWall.get(50)).toEqual([
      [0, 0],
      [5, 0],
    ]);
  });

  it('does not compose them into an existing space footprint either', async () => {
    const store = await parse();
    const byStorey = existingSpaceFootprintsByStorey(store);
    expect(byStorey.get(4)).toEqual([
      [
        [1, 0],
        [3, 0],
        [3, 2],
        [1, 2],
      ],
    ]);
  });
});
