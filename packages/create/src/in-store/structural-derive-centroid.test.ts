/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #9934: an asymmetric section is idealised through its centroid, not the centre of its bounds.
// Expected offsets (mm, from the centre of the bounds) come from an IfcOpenShell pass over the
// same profiles (ifcopenshell 0.8.2, volume-weighted centroid of the extruded body), not from
// this module's formulas. IfcOpenShell builds no mesh for IfcAsymmetricIShapeProfileDef, so those
// beams (#244 to #284) are measured on the same twelve-point outline written as an
// IfcArbitraryClosedProfileDef (origin at the centre of the bounds, bottom flange at -y: the frame
// rust/geometry/src/profiles/shapes.rs draws it in). That fixes the numbers, not the frame: no tool
// states which way an asymmetric I is authored, so the orientation is the viewer's own drawing.
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
#80=IFCCARTESIANPOINT((0.025,0.));
#81=IFCAXIS2PLACEMENT2D(#80,$);
#82=IFCCIRCLE(#81,0.02);
${beam(11, 'IFCLSHAPEPROFILEDEF(.AREA.,$,#46,0.1,0.075,0.006,$,$,$)')}
${beam(12, 'IFCTSHAPEPROFILEDEF(.AREA.,$,#46,0.1,0.08,0.006,0.01,$,$,$,$,$)')}
${beam(13, 'IFCUSHAPEPROFILEDEF(.AREA.,$,#46,0.1,0.05,0.006,0.008,$,$,$)')}
${beam(14, 'IFCCSHAPEPROFILEDEF(.AREA.,$,#46,0.1,0.05,0.004,0.015,$)')}
${beam(15, 'IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#65)')}
${beam(16, 'IFCLSHAPEPROFILEDEF(.AREA.,$,#48,0.1,0.075,0.006,$,$,$)')}
${beam(17, 'IFCISHAPEPROFILEDEF(.AREA.,$,#46,0.2,0.1,0.006,0.01,$)')}
${beam(18, 'IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#74,(#79))')}
${beam(19, 'IFCLSHAPEPROFILEDEF(.AREA.,$,#46,0.1,$,0.006,$,$,$)')}
${beam(20, 'IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#74,(#82))')}
${beam(21, 'IFCLSHAPEPROFILEDEF(.AREA.,$,#46,0.075,0.075,0.006,0.01,0.005,0.,0.01707184,0.01707184)')}
${beam(22, 'IFCLSHAPEPROFILEDEF(.AREA.,$,#46,0.075,0.075,0.006,$,$,$,0.0204,0.0204)')}
${beam(23, 'IFCLSHAPEPROFILEDEF(.AREA.,$,#46,0.1,0.1,0.002,$,$,$,0.02574747,0.02574747)')}
${beam(24, 'IFCASYMMETRICISHAPEPROFILEDEF(.AREA.,$,#46,0.2,0.4,0.01,0.02,$,0.1,0.015,$,$,$,$,$)')}
${beam(25, 'IFCASYMMETRICISHAPEPROFILEDEF(.AREA.,$,#46,0.1,0.3,0.008,0.012,$,0.16,0.018,$,$,$,$,$)')}
${beam(26, 'IFCASYMMETRICISHAPEPROFILEDEF(.AREA.,$,#46,0.15,0.5,0.012,0.025,$,0.15,0.025,$,$,$,$,$)')}
${beam(27, 'IFCASYMMETRICISHAPEPROFILEDEF(.AREA.,$,#46,0.12,0.24,0.008,0.014,$,0.12,0.02,$,$,$,$,$)')}
${beam(28, 'IFCASYMMETRICISHAPEPROFILEDEF(.AREA.,$,#46,0.2,0.4,0.01,0.02,$,0.1,$,$,$,$,$,$)')}
${beam(29, 'IFCASYMMETRICISHAPEPROFILEDEF(.AREA.,$,#48,0.2,0.4,0.01,0.02,$,0.1,0.015,$,$,$,$,$)')}
${beam(30, 'IFCASYMMETRICISHAPEPROFILEDEF(.AREA.,$,#46,0.2,0.03,0.01,0.02,$,0.1,0.015,$,$,$,$,$)')}
${beam(31, 'IFCASYMMETRICISHAPEPROFILEDEF(.AREA.,$,#46,0.2,0.4,0.01,0.02,$,$,0.015,$,$,$,$,$)')}
${beam(32, 'IFCASYMMETRICISHAPEPROFILEDEF(.AREA.,$,#46,0.2,0.4,$,0.02,$,0.1,0.015,$,$,$,$,$)')}
${beam(33, 'IFCASYMMETRICISHAPEPROFILEDEF(.AREA.,$,#46,0.2,0.4,0.,0.02,$,0.1,0.015,$,$,$,$,$)')}
${beam(34, 'IFCASYMMETRICISHAPEPROFILEDEF(.AREA.,$,#46,0.2,0.4,0.01,$,$,0.1,0.015,$,$,$,$,$)')}
${beam(35, 'IFCASYMMETRICISHAPEPROFILEDEF(.AREA.,$,#46,0.2,0.035,0.01,0.02,$,0.1,0.015,$,$,$,$,$)')}
${beam(36, "IFCASYMMETRICISHAPEPROFILEDEF(.AREA.,$,#46,0.2,0.4,0.01,0.02,$,0.1,'x',$,$,$,$,$)")}
${beam(37, 'IFCTSHAPEPROFILEDEF(.AREA.,$,#46,0.1,0.1,0.006,0.015,0.008,0.004,$,$,$,0.0298391)')}
${beam(38, 'IFCTSHAPEPROFILEDEF(.AREA.,$,#46,0.1,0.08,0.006,0.01,0.008,0.004,$,$,$,0.0250445)')}
${beam(39, 'IFCUSHAPEPROFILEDEF(.AREA.,$,#46,0.2,0.075,0.0085,0.0115,0.012,0.006,$,0.0159503)')}
${beam(40, 'IFCUSHAPEPROFILEDEF(.AREA.,$,#46,0.2,0.075,0.0085,0.0115,0.012,0.006,$,0.0215497)')}
${beam(41, 'IFCCSHAPEPROFILEDEF(.AREA.,$,#46,0.2,0.1,0.003,0.025,0.003,0.0169171)')}
${beam(42, 'IFCASYMMETRICISHAPEPROFILEDEF(.AREA.,$,#46,0.2,0.4,0.01,0.02,0.015,0.1,0.015,0.01,0.0507456)')}
${beam(43, 'IFCASYMMETRICISHAPEPROFILEDEF(.AREA.,$,#46,0.1,0.3,0.008,0.012,0.01,0.16,0.018,0.01,0.0357961)')}
${beam(44, 'IFCASYMMETRICISHAPEPROFILEDEF(.AREA.,$,#46,0.2,0.4,0.01,0.02,0.015,0.1,0.015,0.01,0.0507456,$,$,$)')}
${beam(45, 'IFCTSHAPEPROFILEDEF(.AREA.,$,#46,0.1,0.1,0.006,0.015,0.008,0.004,$,$,$)')}
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
  214: [-17.085, -17.085], // the AxisVM L (75 x 75 x 6, 10 mm fillet, 5 mm edge radius) states 17.07184: IfcOpenShell measures 17.085
  224: [-16.531, -16.531], // the same angle without fillets; a stated 20.4 mm (measured from the outer edge) disagrees by 23% and is ignored
  234: [-24.253, -24.253], // thin 100 x 100 x 2 angle stating 25.747 (the outer-edge distance), which is also within 10% of the 24.253 offset: ambiguous, so the computed one stays
  294: [50.5055, 0], // #244 with the profile Position rotated 90 degrees: the offset turns with it
  244: [0, -50.5055], // IfcAsymmetricIShapeProfileDef: bottom flange 200 x 20, top 100 x 15, depth 400, web 10 (measured on the outline, see the header)
  254: [0, 36.3462], // wider top flange: bottom 100 x 12, top 160 x 18, depth 300, web 8
  264: [0, 0], // equal flanges are symmetric
  274: [0, 12.0838], // equal widths, a thicker top flange (120 x 14 below, 120 x 20 above), depth 240
  284: [0, -39.5833], // TopFlangeThickness omitted is the bottom flange's (schema rule WR3): 20 mm on both
  // Stated IFC2X3 CentreOfGravityInX/Y on T, U, C and asymmetric I (#10377): each states IfcOpenShell 0.8.4's centroid of the
  // filleted section, measured from the bounds centre as the IFC2x3 TC1 text defines it.
  374: [0, 29.8391], // T, flange 100 x 15, 8 mm fillet: stated and used (sharp corners give 29.813)
  384: [0, 24.851], // T, flange 80 x 10: the centroid sits near the quarter point, so a distance from the flange face reads alike; computed kept
  394: [-15.9503, 0], // U 200 x 75, 12 mm fillet: stated and used (sharp corners give -15.490)
  404: [-15.490, 0], // the same U stating 21.55, the distance from the web back: 39% off, ignored
  414: [-16.9171, 0], // lipped C 200 x 100 x 3, girth 25, 3 mm fillet: stated and used (sharp corners give -16.610)
  424: [0, -50.7456], // asymmetric I of #244 with fillets: stated and used, toward the wider bottom flange
  434: [0, 35.7961], // asymmetric I with the wider flange on top: the TC1 text says negative y, the computed sign (+y) is kept
  444: [0, -50.5055], // IFC4 arity: slot 11 is BottomFlangeEdgeRadius, never a centre of gravity
  454: [0, 29.813], // the T of #374 without a stated value
  204: [-3.553, 0], // the same square with a 20 mm radius circular void 25 mm right of the centre (IfcOpenShell tessellates the circle; the exact disc gives -3.593)
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
      // The circular void is a polygon to IfcOpenShell and a disc here, and the fillets of #214 are meshed there: each agrees to 0.05 mm.
      const digits = [204, 214].includes(Number(id)) ? 1 : 2;
      expect(start[0] * 1000, `#${id} x`).toBeCloseTo(cx + dx, digits);
      expect(start[1] * 1000, `#${id} y`).toBeCloseTo(cy + dy, digits);
      expect(end[0]).toBeCloseTo(start[0], 9);
      expect([start[2], end[2]]).toEqual([0, 3]);
    }
  });

  it('refuses an asymmetric I it cannot idealise (#10377)', async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(STEP).buffer as ArrayBuffer);
    const axes = structuralPhysicalAxes(store);
    expect(axes.has(304), 'depth 30 mm under flanges of 20 + 15 mm').toBe(false);
    expect(axes.has(314), 'TopFlangeWidth missing').toBe(false);
    expect(axes.has(324), 'WebThickness missing').toBe(false);
    expect(axes.has(334), 'WebThickness zero').toBe(false);
    expect(axes.has(344), 'BottomFlangeThickness missing').toBe(false);
    expect(axes.has(354), 'depth equal to the two flange thicknesses leaves no web').toBe(false);
    expect(axes.has(364), 'TopFlangeThickness present but unreadable').toBe(false);
  });
});
