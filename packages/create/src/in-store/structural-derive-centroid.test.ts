/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #9934: an asymmetric section is idealised through its centroid, not the centre of its bounds.
// Expected offsets (mm, from the centre of the bounds) come from an IfcOpenShell pass over the
// same profiles (ifcopenshell 0.8.2, volume-weighted centroid of the extruded body), not from
// this module's formulas.
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { structuralPhysicalAxes } from './structural-check-axes.js';

const beam = (id: number, profile: string, position = '$') => `#${id}0=${profile};
#${id}1=IFCEXTRUDEDAREASOLID(#${id}0,#${position === '$' ? 5 : position},#44,3.);
#${id}2=IFCSHAPEREPRESENTATION(#7,'Body','SweptSolid',(#${id}1));
#${id}3=IFCPRODUCTDEFINITIONSHAPE($,$,(#${id}2));
#${id}4=IFCBEAM('0beam${id}000000000000000',$,'B${id}',$,$,#20,#${id}3,$,$);`;

const STEP = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('x.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,#9);
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#5,$);
#9=IFCUNITASSIGNMENT((#91));
#91=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCLOCALPLACEMENT($,#5);
#44=IFCDIRECTION((0.,0.,1.));
#45=IFCCARTESIANPOINT((0.,0.));
#46=IFCAXIS2PLACEMENT2D(#45,$);
#47=IFCDIRECTION((0.,1.));
#48=IFCAXIS2PLACEMENT2D(#45,#47);
#60=IFCCARTESIANPOINT((0.075,0.));
#61=IFCCARTESIANPOINT((0.075,0.006));
#62=IFCCARTESIANPOINT((0.006,0.006));
#63=IFCCARTESIANPOINT((0.006,0.1));
#64=IFCCARTESIANPOINT((0.,0.1));
#65=IFCPOLYLINE((#45,#60,#61,#62,#63,#64,#45));
#70=IFCCARTESIANPOINT((-0.05,-0.05));
#71=IFCCARTESIANPOINT((0.05,-0.05));
#72=IFCCARTESIANPOINT((0.05,0.05));
#73=IFCCARTESIANPOINT((-0.05,0.05));
#74=IFCPOLYLINE((#70,#71,#72,#73,#70));
#75=IFCCARTESIANPOINT((0.005,-0.02));
#76=IFCCARTESIANPOINT((0.045,-0.02));
#77=IFCCARTESIANPOINT((0.045,0.02));
#78=IFCCARTESIANPOINT((0.005,0.02));
#79=IFCPOLYLINE((#75,#76,#77,#78,#75));
${beam(11, 'IFCLSHAPEPROFILEDEF(.AREA.,$,#46,0.1,0.075,0.006,$,$,$)')}
${beam(12, 'IFCTSHAPEPROFILEDEF(.AREA.,$,#46,0.1,0.08,0.006,0.01,$,$,$,$,$)')}
${beam(13, 'IFCUSHAPEPROFILEDEF(.AREA.,$,#46,0.1,0.05,0.006,0.008,$,$,$)')}
${beam(14, 'IFCCSHAPEPROFILEDEF(.AREA.,$,#46,0.1,0.05,0.004,0.015,$)')}
${beam(15, 'IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#65)')}
${beam(16, 'IFCLSHAPEPROFILEDEF(.AREA.,$,#48,0.1,0.075,0.006,$,$,$)')}
${beam(17, 'IFCISHAPEPROFILEDEF(.AREA.,$,#46,0.2,0.1,0.006,0.01,$)')}
${beam(18, 'IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#74,(#79))')}
${beam(19, 'IFCLSHAPEPROFILEDEF(.AREA.,$,#46,0.1,$,0.006,$,$,$)')}
ENDSEC;
END-ISO-10303-21;`;

/** Beam id -> [dx, dy] in mm from the centre of the profile bounds, from IfcOpenShell. */
const ORACLE: Record<number, [number, number]> = {
  114: [-19.189, -19.189], // IfcLShapeProfileDef 100 x 75 x 6
  124: [0, 24.851], // IfcTShapeProfileDef depth 100, flange 80 x 10, web 6
  134: [-8.503, 0], // IfcUShapeProfileDef depth 100, flange 50 x 8, web 6
  144: [-7.523, 0], // IfcCShapeProfileDef depth 100, width 50, wall 4, girth 15
  154: [-19.189, -19.189], // arbitrary closed L polygon, bounds 75 x 100
  164: [19.189, -19.189], // the L with its profile Position rotated 90 degrees
  174: [0, 0], // IfcIShapeProfileDef is symmetric
  184: [-4.762, 0], // 100 x 100 rectangle with a 40 x 40 void centred 25 mm right of the centre
  194: [-22.773, -22.773], // IfcLShapeProfileDef 100 x (Width omitted = Depth) x 6
};
// Bounds centre of each profile in the profile frame (mm): the polygon's lower-left corner is the origin.
const BOUNDS_CENTRE: Record<number, [number, number]> = { 154: [37.5, 50] };

describe('structural derive idealises an asymmetric section through its centroid (#9934)', () => {
  it('puts the member on the centroid line, as IfcOpenShell measures it', async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(STEP).buffer as ArrayBuffer);
    const axes = structuralPhysicalAxes(store);
    expect(axes.size).toBe(Object.keys(ORACLE).length);
    for (const [id, [dx, dy]] of Object.entries(ORACLE)) {
      const line = axes.get(Number(id));
      expect(line, `beam #${id}`).toBeDefined();
      const [cx, cy] = BOUNDS_CENTRE[Number(id)] ?? [0, 0];
      const [start, end] = line!;
      expect(start[0] * 1000, `#${id} x`).toBeCloseTo(cx + dx, 2);
      expect(start[1] * 1000, `#${id} y`).toBeCloseTo(cy + dy, 2);
      expect(end[0]).toBeCloseTo(start[0], 9);
      expect([start[2], end[2]]).toEqual([0, 3]);
    }
  });
});
