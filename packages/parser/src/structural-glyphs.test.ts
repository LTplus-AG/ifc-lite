/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The support and load glyph list (#9668). Expected positions and directions
 * are worked out by hand from each file's records (placements, vertices,
 * units), never read back from the module under test.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IfcParser } from './index.js';
import { extractStructuralOnDemand } from './structural-extractor.js';
import { structuralGlyphs, type StructuralGlyph } from './structural-glyphs.js';
import type { ItemShape } from './structural-item-geometry.js';
import { structuralSupportKind } from './structural-support-kind.js';
import { shapeCentre, shapeStations } from './structural-glyph-stations.js';
import { varyingParts } from './structural-glyph-varying.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function glyphsOf(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const store = await new IfcParser().parseColumnar(buffer);
  const extraction = extractStructuralOnDemand(store);
  return { store, extraction, glyphs: structuralGlyphs(store, extraction) };
}

const close = (actual: readonly number[] | undefined, expected: readonly number[]) => {
  expect(actual).toBeDefined();
  actual!.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 6));
};
const bySource = (glyphs: StructuralGlyph[], expressId: number) => glyphs.filter((g) => g.source.expressId === expressId);

const id = (n: number) => `'0Glyph${String(n).padStart(16, '0')}'`;
const T = 'IFCBOOLEAN(.T.)';
const F = 'IFCBOOLEAN(.F.)';

/**
 * Millimetres. Every item sits in placement #23: #20 moves 1000 mm along X,
 * #24 lifts 500 mm and turns 90 degrees about Z (RefDirection +Y), so a local
 * (x, y, z) mm lands at world (1 - y/1000, x/1000, 0.5 + z/1000) m.
 * Vertices: #30 -> (1, 0, 0.5), #31 -> (1, 2, 0.5), #32 -> (1, 2, 3.5), #33 -> (1, 0, 3.5).
 */
const SYNTHETIC = `ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('g.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT(${id(1)},$,'P',$,$,$,$,(#3),#2);
#2=IFCUNITASSIGNMENT((#4));
#3=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#4=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((1000.,0.,0.));
#23=IFCLOCALPLACEMENT(#20,#24);
#24=IFCAXIS2PLACEMENT3D(#25,#26,#27);
#25=IFCCARTESIANPOINT((0.,0.,500.));
#26=IFCDIRECTION((0.,0.,1.));
#27=IFCDIRECTION((0.,1.,0.));
#30=IFCCARTESIANPOINT((0.,0.,0.));
#31=IFCCARTESIANPOINT((2000.,0.,0.));
#32=IFCCARTESIANPOINT((2000.,0.,3000.));
#33=IFCCARTESIANPOINT((0.,0.,3000.));
#40=IFCVERTEXPOINT(#30);
#41=IFCVERTEXPOINT(#31);
#42=IFCVERTEXPOINT(#32);
#43=IFCVERTEXPOINT(#33);
#44=IFCTOPOLOGYREPRESENTATION(#3,'Reference','Vertex',(#40));
#45=IFCPRODUCTDEFINITIONSHAPE($,$,(#44));
#46=IFCTOPOLOGYREPRESENTATION(#3,'Reference','Vertex',(#41));
#47=IFCPRODUCTDEFINITIONSHAPE($,$,(#46));
#48=IFCTOPOLOGYREPRESENTATION(#3,'Reference','Vertex',(#42));
#49=IFCPRODUCTDEFINITIONSHAPE($,$,(#48));
#50=IFCTOPOLOGYREPRESENTATION(#3,'Reference','Vertex',(#43));
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#52=IFCBOUNDARYNODECONDITION('fixed',${T},${T},${T},${T},${T},${T});
#53=IFCSTRUCTURALPOINTCONNECTION(${id(53)},$,'N1',$,$,#23,#45,#52,$);
#54=IFCBOUNDARYNODECONDITION('pinned',${T},${T},${T},${F},${F},${F});
#55=IFCAXIS2PLACEMENT3D(#30,#59,$);
#59=IFCDIRECTION((1.,0.,0.));
#56=IFCSTRUCTURALPOINTCONNECTION(${id(56)},$,'N2',$,$,#23,#47,#54,#55);
#57=IFCBOUNDARYNODECONDITION('roller',${F},${F},${T},${F},${F},${F});
#58=IFCSTRUCTURALPOINTCONNECTION(${id(58)},$,'N3',$,$,#23,#49,#57,$);
#60=IFCBOUNDARYNODECONDITION('spring',${F},${F},IFCLINEARSTIFFNESSMEASURE(5000.),${F},${F},${F});
#61=IFCSTRUCTURALPOINTCONNECTION(${id(61)},$,'N4',$,$,#23,#51,#60,$);
#62=IFCBOUNDARYNODECONDITION('free',${F},${F},${F},${F},${F},${F});
#63=IFCSTRUCTURALPOINTCONNECTION(${id(63)},$,'N5',$,$,#23,#45,#62,$);
#64=IFCEDGE(#40,#41);
#65=IFCTOPOLOGYREPRESENTATION(#3,'Reference','Edge',(#64));
#66=IFCPRODUCTDEFINITIONSHAPE($,$,(#65));
#67=IFCDIRECTION((0.,0.,1.));
#68=IFCSTRUCTURALCURVEMEMBER(${id(68)},$,'M1',$,$,#23,#66,.RIGID_JOINED_MEMBER.,#67);
#70=IFCPOLYLOOP((#30,#31,#32,#33));
#71=IFCFACEOUTERBOUND(#70,.T.);
#72=IFCFACESURFACE((#71),#73,.T.);
#73=IFCPLANE(#21);
#74=IFCTOPOLOGYREPRESENTATION(#3,'Reference','Face',(#72));
#75=IFCPRODUCTDEFINITIONSHAPE($,$,(#74));
#76=IFCSTRUCTURALSURFACEMEMBER(${id(76)},$,'S1',$,$,#23,#75,.SHELL.,200.);
#80=IFCSTRUCTURALLOADSINGLEFORCE('P1',3.,4.,0.,0.,0.,2.);
#81=IFCSTRUCTURALPOINTACTION(${id(81)},$,'A1',$,$,$,$,#80,.GLOBAL_COORDS.,.F.);
#82=IFCSTRUCTURALLOADSINGLEFORCE('P2',0.,0.,-10.,$,$,$);
#83=IFCSTRUCTURALPOINTACTION(${id(83)},$,'A2',$,$,$,$,#82,.GLOBAL_COORDS.,.F.);
#84=IFCSTRUCTURALLOADSINGLEFORCE('P3',0.,0.,-2.,$,$,$);
#85=IFCSTRUCTURALPOINTACTION(${id(85)},$,'A3',$,$,#23,$,#84,.GLOBAL_COORDS.,.F.);
#86=IFCSTRUCTURALLOADSINGLEFORCE('P4',0.,0.,-1.,$,$,$);
#87=IFCSTRUCTURALPOINTACTION(${id(87)},$,'A4',$,$,$,$,#86,.LOCAL_COORDS.,.F.);
#90=IFCSTRUCTURALLOADLINEARFORCE('q',$,$,-5.,$,$,$);
#91=IFCSTRUCTURALLINEARACTION(${id(91)},$,'L1',$,$,$,$,#90,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);
#92=IFCSTRUCTURALLOADLINEARFORCE('qy',$,1.,$,$,$,$);
#93=IFCSTRUCTURALLINEARACTION(${id(93)},$,'L2',$,$,$,$,#92,.LOCAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);
#94=IFCSTRUCTURALLOADPLANARFORCE('w',-3.,$,$);
#95=IFCSTRUCTURALPLANARACTION(${id(95)},$,'W1',$,$,$,$,#94,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);
#96=IFCSTRUCTURALLOADTEMPERATURE('T',20.,$,$);
#97=IFCSTRUCTURALLINEARACTION(${id(97)},$,'T1',$,$,$,$,#96,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);
#98=IFCSTRUCTURALLOADSINGLEDISPLACEMENT('d',0.,0.,-0.01,$,$,$);
#99=IFCSTRUCTURALPOINTACTION(${id(99)},$,'D1',$,$,$,$,#98,.GLOBAL_COORDS.,.F.);
#100=IFCSTRUCTURALPOINTREACTION(${id(100)},$,'R1',$,$,$,$,#80,.GLOBAL_COORDS.);
#101=IFCSTRUCTURALPOINTACTION(${id(101)},$,'A5',$,$,#23,$,#80,.GLOBAL_COORDS.,.F.);
#120=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(120)},$,$,$,#53,#81);
#121=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(121)},$,$,$,#58,#83);
#122=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(122)},$,$,$,#56,#85);
#123=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(123)},$,$,$,#56,#87);
#124=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(124)},$,$,$,#68,#91);
#125=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(125)},$,$,$,#68,#93);
#126=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(126)},$,$,$,#76,#95);
#127=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(127)},$,$,$,#68,#97);
#128=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(128)},$,$,$,#61,#99);
#129=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(129)},$,$,$,#53,#100);
#130=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(130)},$,$,$,#68,#101);
#102=IFCSTRUCTURALLOADSINGLEFORCE('P6',1.,0.,0.,$,$,$);
#103=IFCSTRUCTURALPOINTACTION(${id(103)},$,'A6',$,$,$,$,#102,.GLOBAL_COORDS.,.F.);
#131=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(131)},$,$,$,#53,#103);
#140=IFCSTRUCTURALANALYSISMODEL(${id(140)},$,'Turned',$,$,.LOADING_3D.,$,(#160,#162),$,#23);
#160=IFCSTRUCTURALLOADGROUP(${id(160)},$,'G3',$,$,.LOAD_GROUP.,.PERMANENT_G.,.DEAD.,1.,$);
#105=IFCSTRUCTURALPOINTACTION(${id(105)},$,'A7',$,$,$,$,#102,.GLOBAL_COORDS.,.F.);
#132=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(132)},$,$,$,#53,#105);
#161=IFCRELASSIGNSTOGROUP(${id(161)},$,$,$,(#105),$,#160);
#200=IFCCARTESIANPOINT((1000.,1000.,500.));
#201=IFCAXIS2PLACEMENT3D(#200,$,$);
#202=IFCLOCALPLACEMENT($,#201);
#203=IFCSTRUCTURALPOINTACTION(${id(203)},$,'A8',$,$,#202,$,#102,.GLOBAL_COORDS.,.F.);
#204=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(204)},$,$,$,#68,#203);
#205=IFCCARTESIANPOINT((1500.,0.,0.));
#206=IFCAXIS2PLACEMENT3D(#205,$,$);
#207=IFCLOCALPLACEMENT($,#206);
#208=IFCSTRUCTURALPOINTACTION(${id(208)},$,'A9',$,$,#207,$,#102,.GLOBAL_COORDS.,.F.);
#209=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(209)},$,$,$,#68,#208);
#210=IFCCARTESIANPOINT((5000.,0.,0.));
#211=IFCAXIS2PLACEMENT3D(#210,$,$);
#212=IFCLOCALPLACEMENT($,#211);
#213=IFCSTRUCTURALPOINTACTION(${id(213)},$,'A10',$,$,#212,$,#102,.GLOBAL_COORDS.,.F.);
#214=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(214)},$,$,$,#68,#213);
#220=IFCAXIS2PLACEMENT3D(#30,$,$);
#217=IFCLOCALPLACEMENT($,#220);
#218=IFCSTRUCTURALPOINTACTION(${id(218)},$,'A12',$,$,#217,$,#102,.GLOBAL_COORDS.,.F.);
#219=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(219)},$,$,$,#68,#218);
#215=IFCSTRUCTURALPOINTACTION(${id(215)},$,'A11',$,$,$,$,#102,.GLOBAL_COORDS.,.F.);
#216=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(216)},$,$,$,#215,#58);
#143=IFCSTRUCTURALANALYSISMODEL(${id(143)},$,'Broken',$,$,.LOADING_3D.,$,$,$,#24);
#106=IFCSTRUCTURALPOINTACTION(${id(106)},$,'A8',$,$,$,$,#102,.GLOBAL_COORDS.,.F.);
#133=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(133)},$,$,$,#53,#106);
#144=IFCRELASSIGNSTOGROUP(${id(144)},$,$,$,(#106),$,#143);
#141=IFCSTRUCTURALANALYSISMODEL(${id(141)},$,'Reversed',$,$,.LOADING_3D.,$,(#162),$,#170);
#170=IFCLOCALPLACEMENT($,#171);
#171=IFCAXIS2PLACEMENT3D(#22,#26,#172);
#172=IFCDIRECTION((-1.,0.,0.));
#162=IFCSTRUCTURALLOADGROUP(${id(162)},$,'G4',$,$,.LOAD_GROUP.,.PERMANENT_G.,.DEAD.,1.,$);
#107=IFCSTRUCTURALPOINTACTION(${id(107)},$,'A9',$,$,$,$,#102,.GLOBAL_COORDS.,.F.);
#134=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(134)},$,$,$,#53,#107);
#163=IFCRELASSIGNSTOGROUP(${id(163)},$,$,$,(#107),$,#162);
#142=IFCRELASSIGNSTOGROUP(${id(142)},$,$,$,(#103),$,#140);
#150=IFCBOUNDARYEDGECONDITION('line',${T},${T},${T},${T},${T},${T});
#151=IFCDIRECTION((0.,1.,0.));
#152=IFCSTRUCTURALCURVECONNECTION(${id(152)},$,'C1',$,$,#23,#66,#150,#151);
#110=IFCSTRUCTURALLOADGROUP(${id(110)},$,'G1',$,$,.LOAD_GROUP.,.PERMANENT_G.,.DEAD.,1.,$);
#111=IFCSTRUCTURALLOADGROUP(${id(111)},$,'G2',$,$,.LOAD_GROUP.,.PERMANENT_G.,.DEAD.,1.,$);
#112=IFCRELASSIGNSTOGROUP(${id(112)},$,$,$,(#81,#83),$,#110);
#113=IFCRELASSIGNSTOGROUP(${id(113)},$,$,$,(#85,#87),$,#111);
ENDSEC;END-ISO-10303-21;`;

/**
 * Metres, identity placements. A vertical surface member in the world YZ
 * plane whose polygon starts at (0, 2, 0), on an IfcPlane with Axis +X and
 * RefDirection +Y (surface x = +Y, y = +Z, z = +X). A curve member along +Y
 * at x = 5 with Axis +Z. A bare IfcFace slab at z = 10 wound clockwise seen
 * from above (winding normal -Z) under an identity placement (z +Z).
 */
const FRAMES = `ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('f.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT(${id(1)},$,'P',$,$,$,$,(#3),#2);
#2=IFCUNITASSIGNMENT((#4));
#3=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#4=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCCARTESIANPOINT((0.,2.,0.));
#31=IFCCARTESIANPOINT((0.,2.,2.));
#32=IFCCARTESIANPOINT((0.,0.,2.));
#33=IFCCARTESIANPOINT((0.,0.,0.));
#34=IFCPOLYLOOP((#30,#31,#32,#33));
#35=IFCFACEOUTERBOUND(#34,.T.);
#36=IFCDIRECTION((1.,0.,0.));
#37=IFCDIRECTION((0.,1.,0.));
#38=IFCAXIS2PLACEMENT3D(#22,#36,#37);
#39=IFCPLANE(#38);
#40=IFCFACESURFACE((#35),#39,.T.);
#41=IFCTOPOLOGYREPRESENTATION(#3,'Reference','Face',(#40));
#42=IFCPRODUCTDEFINITIONSHAPE($,$,(#41));
#43=IFCSTRUCTURALSURFACEMEMBER(${id(43)},$,'Wall',$,$,#20,#42,.SHELL.,0.2);
#44=IFCBOUNDARYFACECONDITION('fixed',${T},${T},${T});
#45=IFCSTRUCTURALSURFACECONNECTION(${id(45)},$,'Bed',$,$,#20,#42,#44);
#50=IFCSTRUCTURALLOADPLANARFORCE('px',1.,$,$);
#51=IFCSTRUCTURALPLANARACTION(${id(51)},$,'PX',$,$,$,$,#50,.LOCAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);
#52=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(52)},$,$,$,#43,#51);
#53=IFCSTRUCTURALLOADPLANARFORCE('w1',$,$,-2.);
#54=IFCSTRUCTURALLOADPLANARFORCE('w2',$,$,-4.);
#55=IFCSTRUCTURALLOADCONFIGURATION('cfg',(#53,#54),((1.,0.5),(1.5,1.5)));
#56=IFCSTRUCTURALPLANARACTION(${id(56)},$,'PC',$,$,$,$,#55,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.LINEAR.);
#57=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(57)},$,$,$,#43,#56);
#60=IFCCARTESIANPOINT((0.,0.,1.));
#61=IFCCARTESIANPOINT((0.,2.,1.));
#62=IFCVERTEXPOINT(#60);
#63=IFCVERTEXPOINT(#61);
#64=IFCEDGE(#62,#63);
#65=IFCTOPOLOGYREPRESENTATION(#3,'Reference','Edge',(#64));
#66=IFCPRODUCTDEFINITIONSHAPE($,$,(#65));
#67=IFCSTRUCTURALLOADLINEARFORCE('qz',$,$,1.,$,$,$);
#68=IFCSTRUCTURALLINEARACTION(${id(68)},$,'QZ',$,$,#20,#66,#67,.LOCAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);
#69=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(69)},$,$,$,#43,#68);
#70=IFCCARTESIANPOINT((5.,0.,0.));
#71=IFCCARTESIANPOINT((5.,2.,0.));
#72=IFCVERTEXPOINT(#70);
#73=IFCVERTEXPOINT(#71);
#74=IFCEDGE(#72,#73);
#75=IFCTOPOLOGYREPRESENTATION(#3,'Reference','Edge',(#74));
#76=IFCPRODUCTDEFINITIONSHAPE($,$,(#75));
#77=IFCDIRECTION((0.,0.,1.));
#78=IFCSTRUCTURALCURVEMEMBER(${id(78)},$,'Beam',$,$,#20,#76,.RIGID_JOINED_MEMBER.,#77);
#80=IFCCARTESIANPOINT((5.,1.,0.));
#81=IFCVERTEXPOINT(#80);
#82=IFCTOPOLOGYREPRESENTATION(#3,'Reference','Vertex',(#81));
#83=IFCPRODUCTDEFINITIONSHAPE($,$,(#82));
#84=IFCSTRUCTURALLOADSINGLEFORCE('fx',1.,0.,0.,$,$,$);
#85=IFCSTRUCTURALPOINTACTION(${id(85)},$,'FX',$,$,#20,#83,#84,.LOCAL_COORDS.,.F.);
#86=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(86)},$,$,$,#78,#85);
#90=IFCSTRUCTURALLOADSINGLEFORCE('F100',$,$,-100.,$,$,$);
#91=IFCSTRUCTURALLOADCONFIGURATION('discrete',(#90),((1.)));
#92=IFCSTRUCTURALCURVEACTION(${id(92)},$,'DP',$,$,$,$,#91,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.DISCRETE.);
#93=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(93)},$,$,$,#78,#92);
#94=IFCSTRUCTURALLOADLINEARFORCE('q10',$,$,-10.,$,$,$);
#95=IFCSTRUCTURALCURVEACTION(${id(95)},$,'Q10',$,$,$,$,#94,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);
#96=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(96)},$,$,$,#78,#95);
#97=IFCSTRUCTURALLOADGROUP(${id(97)},$,'G',$,$,.LOAD_GROUP.,.PERMANENT_G.,.DEAD.,1.,$);
#98=IFCRELASSIGNSTOGROUP(${id(98)},$,$,$,(#92,#95),$,#97);
#280=IFCSTRUCTURALLOADSINGLEFORCE('u1',$,$,-1.,$,$,$);
#281=IFCSTRUCTURALPOINTACTION(${id(281)},$,'U1',$,$,#20,#83,#280,.GLOBAL_COORDS.,.F.);
#282=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(282)},$,$,$,#78,#281);
#283=IFCSTRUCTURALLOADSINGLEFORCE('u100',$,$,-100.,$,$,$);
#284=IFCSTRUCTURALPOINTACTION(${id(284)},$,'U100',$,$,#20,#83,#283,.GLOBAL_COORDS.,.F.);
#285=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(285)},$,$,$,#78,#284);
#200=IFCCARTESIANPOINT((0.,0.,10.));
#201=IFCCARTESIANPOINT((0.,1.,10.));
#202=IFCCARTESIANPOINT((1.,1.,10.));
#203=IFCCARTESIANPOINT((1.,0.,10.));
#204=IFCPOLYLOOP((#200,#201,#202,#203));
#205=IFCFACEOUTERBOUND(#204,.T.);
#206=IFCFACE((#205));
#207=IFCTOPOLOGYREPRESENTATION(#3,'Reference','Face',(#206));
#208=IFCPRODUCTDEFINITIONSHAPE($,$,(#207));
#209=IFCSTRUCTURALSURFACEMEMBER(${id(209)},$,'Slab',$,$,#20,#208,.SHELL.,0.2);
#210=IFCSTRUCTURALSURFACECONNECTION(${id(210)},$,'SlabBed',$,$,#20,#208,#44);
#211=IFCSTRUCTURALLOADPLANARFORCE('pz',$,$,-1.);
#212=IFCSTRUCTURALPLANARACTION(${id(212)},$,'PZ',$,$,$,$,#211,.LOCAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);
#213=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(213)},$,$,$,#209,#212);
#232=IFCCARTESIANPOINT((0.,0.,-10.));
#233=IFCCARTESIANPOINT((0.,-1.,-10.));
#220=IFCVERTEXPOINT(#232);
#221=IFCVERTEXPOINT(#233);
#222=IFCEDGE(#220,#221);
#223=IFCTOPOLOGYREPRESENTATION(#3,'Reference','Edge',(#222));
#224=IFCPRODUCTDEFINITIONSHAPE($,$,(#223));
#225=IFCDIRECTION((0.,0.,-1.));
#226=IFCDIRECTION((1.,0.,0.));
#227=IFCAXIS2PLACEMENT3D(#22,#225,#226);
#228=IFCLOCALPLACEMENT($,#227);
#229=IFCSTRUCTURALLOADLINEARFORCE('ez',$,$,-1.,$,$,$);
#230=IFCSTRUCTURALLINEARACTION(${id(230)},$,'EZ',$,$,#228,#224,#229,.LOCAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);
#231=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(231)},$,$,$,#209,#230);
#234=IFCCARTESIANPOINT((1.,-1.,-10.));
#235=IFCCARTESIANPOINT((1.,0.,-10.));
#236=IFCPOLYLOOP((#232,#233,#234,#235));
#237=IFCFACEOUTERBOUND(#236,.T.);
#238=IFCFACE((#237));
#239=IFCTOPOLOGYREPRESENTATION(#3,'Reference','Face',(#238));
#240=IFCPRODUCTDEFINITIONSHAPE($,$,(#239));
#241=IFCSTRUCTURALPLANARACTION(${id(241)},$,'OZ',$,$,#228,#240,#211,.LOCAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);
#242=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(242)},$,$,$,#209,#241);
#250=IFCDIRECTION((0.,0.,1.));
#251=IFCAXIS2PLACEMENT3D(#22,#36,#250);
#252=IFCPLANE(#251);
#253=IFCFACESURFACE((#35),#252,.T.);
#254=IFCTOPOLOGYREPRESENTATION(#3,'Reference','Face',(#253));
#255=IFCPRODUCTDEFINITIONSHAPE($,$,(#254));
#256=IFCSTRUCTURALPLANARACTION(${id(256)},$,'OWNSURF',$,$,#20,#255,#50,.LOCAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);
#257=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(257)},$,$,$,#43,#256);
#260=IFCCARTESIANPOINT((20.,0.,0.));
#261=IFCCARTESIANPOINT((21.,0.,0.));
#262=IFCCARTESIANPOINT((22.,0.,0.));
#263=IFCPOLYLOOP((#260,#261,#262));
#264=IFCFACEOUTERBOUND(#263,.T.);
#265=IFCFACE((#264));
#266=IFCTOPOLOGYREPRESENTATION(#3,'Reference','Face',(#265));
#267=IFCPRODUCTDEFINITIONSHAPE($,$,(#266));
#268=IFCSTRUCTURALSURFACEMEMBER(${id(268)},$,'Flat',$,$,#20,#267,.SHELL.,0.2);
#269=IFCVERTEXPOINT(#261);
#270=IFCTOPOLOGYREPRESENTATION(#3,'Reference','Vertex',(#269));
#271=IFCPRODUCTDEFINITIONSHAPE($,$,(#270));
#272=IFCSTRUCTURALPOINTACTION(${id(272)},$,'ONFLAT',$,$,#20,#271,#84,.LOCAL_COORDS.,.F.);
#273=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(273)},$,$,$,#268,#272);
#274=IFCSTRUCTURALLOADSINGLEFORCE('gz',$,$,-1.,$,$,$);
#275=IFCSTRUCTURALPOINTACTION(${id(275)},$,'ONFLATGLOBAL',$,$,#20,#271,#274,.GLOBAL_COORDS.,.F.);
#276=IFCRELCONNECTSSTRUCTURALACTIVITY(${id(276)},$,$,$,#268,#275);
ENDSEC;END-ISO-10303-21;`;

describe('structuralGlyphs local frames of curve and surface items', () => {
  const load = async () => (await glyphsOf(new TextEncoder().encode(FRAMES))).glyphs;
  const arrows = (glyphs: StructuralGlyph[], source: number) =>
    bySource(glyphs, source).filter((g): g is Extract<StructuralGlyph, { kind: 'force' | 'moment' }> => g.kind === 'force'); // the union member holds both kinds

  it('orients a surface support along the reference surface normal', async () => {
    const supports = bySource(await load(), 45).filter((g) => g.kind === 'support');
    expect(supports.length).toBeGreaterThan(0);
    for (const g of supports) close(g.kind === 'support' ? g.direction : undefined, [1, 0, 0]);
  });

  it('takes a LOCAL_COORDS face load in the reference surface axes, not the first polygon side', async () => {
    const forces = arrows(await load(), 51);
    expect(forces.length).toBeGreaterThan(0);
    // Surface x is world +Y; the first side runs (0, 2, 0) to (0, 2, 2), +Z.
    for (const g of forces) close(g.direction, [0, 1, 0]);
  });

  it('takes an own face reference surface over the surface item it acts on', async () => {
    // Its own plane has x along +Z; the wall's has x along +Y.
    const forces = arrows(await load(), 256);
    expect(forces.length).toBeGreaterThan(0);
    for (const g of forces) close(g.direction, [0, 0, 1]);
  });

  it('draws no local load on a surface item whose face has no frame, rather than guess one', async () => {
    // The member's face is three collinear points; the action has its own vertex.
    const glyphs = await load();
    expect(bySource(glyphs, 272)).toEqual([]);
    // Control: the same vertex and member with a GLOBAL_COORDS load does draw.
    const [control, ...rest] = arrows(glyphs, 275);
    expect(rest).toEqual([]);
    close(control.position, [21, 0, 0]);
    close(control.direction, [0, 0, -1]);
  });

  it('places a surface configuration value at its x and y in the reference surface', async () => {
    const forces = arrows(await load(), 56);
    expect(forces).toHaveLength(2);
    close(forces[0].position, [0, 1, 0.5]);
    close(forces[1].position, [0, 1.5, 1.5]);
    // Ungrouped, but its own values still scale against each other.
    expect(forces.map((g) => g.relative)).toEqual([0.5, 1]);
  });

  it('turns a bare face normal to its placement z, so support and local load agree whatever the winding', async () => {
    const glyphs = await load();
    const supports = bySource(glyphs, 210).filter((g) => g.kind === 'support');
    expect(supports.length).toBeGreaterThan(0);
    for (const g of supports) close(g.kind === 'support' ? g.direction : undefined, [0, 0, 1]);
    const forces = arrows(glyphs, 212);
    expect(forces.length).toBeGreaterThan(0);
    // Local z is +Z, so PlanarForceZ = -1 points down.
    for (const g of forces) close(g.direction, [0, 0, -1]);
    // An edge action on the slab under its own placement turned upside down
    // (local (x, y, z) is world (x, -y, -z), so its edge lies on the slab):
    // the slab's side still comes from the slab's placement, so down is down.
    const edge = arrows(glyphs, 230);
    expect(edge.length).toBeGreaterThan(0);
    // The same for a face action on its own copy of the slab face.
    const face = arrows(glyphs, 241);
    expect(face.length).toBeGreaterThan(0);
    for (const g of [...edge, ...face]) {
      close(g.direction, [0, 0, -1]);
      expect(g.position[2]).toBeCloseTo(10);
    }
  });

  it('takes the local z of a curve action on a surface member from the surface normal', async () => {
    const forces = arrows(await load(), 68);
    expect(forces.length).toBeGreaterThan(0);
    for (const g of forces) close(g.direction, [1, 0, 0]);
  });

  it('takes the local axes of a point action on a curve member from the member', async () => {
    const [force, ...rest] = arrows(await load(), 85);
    expect(rest).toEqual([]);
    close(force.position, [5, 1, 0]);
    // The member runs along world +Y, so its local x is +Y.
    close(force.direction, [0, 1, 0]);
  });

  it('scales an ungrouped action on its own, not against other ungrouped actions', async () => {
    const glyphs = await load();
    for (const source of [281, 284]) {
      const [force, ...rest] = arrows(glyphs, source);
      expect(rest).toEqual([]);
      expect(force.relative).toBeCloseTo(1);
    }
  });

  it('classifies a single force in a discrete curve configuration as a point load, scaled apart from line loads', async () => {
    const glyphs = await load();
    const [point, ...rest] = arrows(glyphs, 92);
    expect(rest).toEqual([]);
    expect([point.distribution, point.magnitude, point.relative]).toEqual(['point', 100, 1]);
    close(point.position, [5, 1, 0]);
    const line = arrows(glyphs, 95);
    expect(line).toHaveLength(5);
    for (const g of line) expect([g.distribution, g.relative]).toEqual(['linear', 1]);
  });
});

describe('structuralGlyphs on synthetic data, one kind each', () => {
  it('draws a support per restraining condition at its node, none for a free one', async () => {
    const { glyphs } = await glyphsOf(new TextEncoder().encode(SYNTHETIC));
    const support = (connection: number) => bySource(glyphs, connection).filter((g) => g.kind === 'support');
    const expectations: [number, string, number[], number[]][] = [
      [53, 'fixed', [1, 0, 0.5], [0, 0, 1]],
      // ConditionCoordinateSystem Axis is local +X, which #24 turns to world +Y.
      [56, 'pinned', [1, 2, 0.5], [0, 1, 0]],
      [58, 'roller', [1, 2, 3.5], [0, 0, 1]],
      [61, 'spring', [1, 0, 3.5], [0, 0, 1]],
    ];
    for (const [connection, kind, position, direction] of expectations) {
      const [glyph, ...rest] = support(connection);
      expect(rest).toEqual([]);
      expect(glyph.kind === 'support' && glyph.support).toBe(kind);
      close(glyph.position, position);
      close(glyph.kind === 'support' ? glyph.direction : undefined, direction);
    }
    expect(support(63)).toEqual([]);
  });

  it('draws point forces and moments in their direction, scaled within the load group', async () => {
    const { glyphs } = await glyphsOf(new TextEncoder().encode(SYNTHETIC));
    const one = (activity: number, kind: string) => {
      const found = bySource(glyphs, activity).filter((g) => g.kind === kind);
      expect(found).toHaveLength(1);
      return found[0] as Extract<StructuralGlyph, { kind: 'force' | 'moment' }>;
    };
    // G1 holds A1 (|F| = 5) and A2 (|F| = 10); G2 holds A3 (2) and A4 (1).
    const a1 = one(81, 'force');
    close(a1.position, [1, 0, 0.5]);
    close(a1.direction, [0.6, 0.8, 0]);
    expect(a1.magnitude).toBeCloseTo(5);
    expect(a1.relative).toBeCloseTo(0.5);
    expect(one(83, 'force').relative).toBeCloseTo(1);
    expect(one(85, 'force').relative).toBeCloseTo(1);
    // LOCAL_COORDS on N2: local -Z is the condition frame's -Z, world -Y.
    const a4 = one(87, 'force');
    close(a4.direction, [0, -1, 0]);
    expect(a4.relative).toBeCloseTo(0.5);
    const moment = one(81, 'moment');
    close(moment.direction, [0, 0, 1]);
    expect(moment.magnitude).toBeCloseTo(2);
  });

  it('draws a row of arrows along a member and a lattice over a face', async () => {
    const { glyphs } = await glyphsOf(new TextEncoder().encode(SYNTHETIC));
    const row = bySource(glyphs, 91);
    expect(row.map((g) => g.kind)).toEqual(Array(5).fill('force'));
    row.forEach((g, i) => close(g.position, [1, i * 0.5, 0.5]));
    row.forEach((g) => close(g.kind === 'force' ? g.direction : undefined, [0, 0, -1]));
    // LOCAL_COORDS on M1: x along the edge (+Y), z the member Axis (+Z), so local +Y is world -X.
    const local = bySource(glyphs, 93);
    expect(local.map((g) => g.kind)).toEqual(Array(5).fill('force'));
    local.forEach((g) => close(g.kind === 'force' ? g.direction : undefined, [-1, 0, 0]));
    const lattice = bySource(glyphs, 95);
    expect(lattice).toHaveLength(9);
    for (const g of lattice) {
      expect(g.kind === 'force' && g.distribution).toBe('planar');
      expect(g.position[0]).toBeCloseTo(1);
      expect(g.position[1]).toBeGreaterThan(0);
      expect(g.position[1]).toBeLessThan(2);
      close(g.kind === 'force' ? g.direction : undefined, [-1, 0, 0]);
    }
  });

  it('draws an action with only its own placement at the connection it acts on', async () => {
    const { glyphs } = await glyphsOf(new TextEncoder().encode(SYNTHETIC));
    // A3 sits on #23 (whose origin is (1, 0, 0.5)) but has no vertex: it acts on N2 at (1, 2, 0.5).
    close(bySource(glyphs, 85)[0].position, [1, 2, 0.5]);
  });

  it('turns GLOBAL_COORDS loads with their analysis model SharedPlacement', async () => {
    const { glyphs } = await glyphsOf(new TextEncoder().encode(SYNTHETIC));
    // A6 is in 'Turned', whose SharedPlacement #23 maps local +X to world +Y.
    const [force] = bySource(glyphs, 103);
    close(force.kind === 'force' ? force.direction : undefined, [0, 1, 0]);
    // A7 reaches 'Turned' only through its load group, which the model is LoadedBy.
    const [loadedBy] = bySource(glyphs, 105);
    close(loadedBy.kind === 'force' ? loadedBy.direction : undefined, [0, 1, 0]);
    // A9's group is loaded by both 'Turned' (+X to +Y) and 'Reversed' (+X to -X), which decides nothing: world axes.
    const [shared] = bySource(glyphs, 107);
    close(shared.kind === 'force' ? shared.direction : undefined, [1, 0, 0]);
    // A8's model points SharedPlacement at an IfcAxis2Placement3D, which is not a placement: refused, not drawn in world axes.
    expect(bySource(glyphs, 106)).toEqual([]);
  });

  it('repeats a curve support along its edge, facing the connection Axis', async () => {
    const { glyphs } = await glyphsOf(new TextEncoder().encode(SYNTHETIC));
    // C1 lies on M1's edge (+Y); its Axis is local +Y, which #23 turns to world -X.
    const supports = bySource(glyphs, 152);
    expect(supports.map((g) => g.kind === 'support' && g.support)).toEqual(Array(5).fill('fixed'));
    supports.forEach((g, i) => close(g.position, [1, i * 0.5, 0.5]));
    supports.forEach((g) => close(g.kind === 'support' ? g.direction : undefined, [-1, 0, 0]));
  });

  it('marks temperature and displacement loads, draws reactions, and refuses a point load on a member at its shared placement', async () => {
    const { glyphs } = await glyphsOf(new TextEncoder().encode(SYNTHETIC));
    const [temperature] = bySource(glyphs, 97);
    expect(temperature.kind).toBe('temperature');
    close(temperature.position, [1, 1, 0.5]);
    const [displacement] = bySource(glyphs, 99);
    expect(displacement.kind).toBe('displacement');
    close(displacement.kind === 'displacement' ? displacement.direction : undefined, [0, 0, -1]);
    // R1, a point reaction at N1 (1, 0, 0.5): force (3, 4, 0), moment about z.
    const reaction = bySource(glyphs, 100);
    expect(reaction.map((g) => [g.kind, g.reaction])).toEqual([['force', true], ['moment', true]]);
    for (const g of reaction) close(g.position, [1, 0, 0.5]);
    close(reaction[0].kind === 'force' ? reaction[0].direction : undefined, [0.6, 0.8, 0]);
    expect(bySource(glyphs, 81).every((g) => g.reaction === undefined)).toBe(true);
    // A5 is a point action on a curve member with no vertex of its own. It shares the
    // member's placement, whose origin is the member's start node: still no position.
    expect(bySource(glyphs, 101)).toEqual([]);
  });

  // Member M1 runs from (1, 0, 0.5) to (1, 2, 0.5).
  it('places a point action with only its own placement on the curve member it acts on (#9668)', async () => {
    const { glyphs } = await glyphsOf(new TextEncoder().encode(SYNTHETIC));
    // A8: origin (1, 1, 0.5) m lies on M1.
    close(bySource(glyphs, 203)[0]?.position, [1, 1, 0.5]);
    // A9: origin (1.5, 0, 0) m is off M1; read in M1's edge frame it is 1.5 m from its start.
    close(bySource(glyphs, 208)[0]?.position, [1, 1.5, 0.5]);
    // A10: origin (5, 0, 0) m is off M1 either way: nothing is drawn.
    expect(bySource(glyphs, 213)).toEqual([]);
    // A12: own placement at the world origin (as an analysis model's often is): off M1 and no station.
    expect(bySource(glyphs, 218)).toEqual([]);
  });

  it('reads an activity relation written with its two ends swapped (#9668)', async () => {
    // A11's relation names it as RelatingElement and connection N3 (1, 2, 3.5) as the activity.
    const { glyphs } = await glyphsOf(new TextEncoder().encode(SYNTHETIC));
    close(bySource(glyphs, 215)[0]?.position, [1, 2, 3.5]);
  });
});

describe('structuralSupportKind', () => {
  const node = (values: (number | boolean | undefined)[]) => ({
    expressId: 1,
    type: 'IfcBoundaryNodeCondition',
    components: Object.fromEntries(['LinearStiffnessX', 'LinearStiffnessY', 'LinearStiffnessZ', 'RotationalStiffnessX', 'RotationalStiffnessY', 'RotationalStiffnessZ']
      .flatMap((name, i) => (values[i] === undefined ? [] : [[name, values[i]!]]))),
  });
  it('reads the IFC2X3 measure conventions: -1 or >= 1e10 fixed, 0 or $ free, otherwise a spring', () => {
    expect(structuralSupportKind(node([-1, -1, -1, -1, -1, -1]), 'IFC2X3')).toBe('fixed');
    expect(structuralSupportKind(node([1e10, 1e10, 1e10, 0, 0, 0]), 'IFC2X3')).toBe('pinned');
    expect(structuralSupportKind(node([0, 0, -1]), 'IFC2X3')).toBe('roller');
    expect(structuralSupportKind(node([1e10, 1e10, 5000]), 'IFC2X3')).toBe('spring');
    expect(structuralSupportKind(node([0, 0, 0, 0, 0, 0]), 'IFC2X3')).toBeNull();
    expect(structuralSupportKind(node([]), 'IFC2X3')).toBeNull();
    expect(structuralSupportKind(undefined, 'IFC2X3')).toBeNull();
  });
  it('reads IFC4 face conditions, which have no rotations', () => {
    const face = { expressId: 2, type: 'IfcBoundaryFaceCondition', components: { TranslationalStiffnessByAreaX: true, TranslationalStiffnessByAreaY: true, TranslationalStiffnessByAreaZ: true } };
    expect(structuralSupportKind(face, 'IFC4')).toBe('pinned');
  });
  it('reads a large IFC4 stiffness as a spring, not as rigid', () => {
    const condition = { expressId: 3, type: 'IfcBoundaryNodeCondition', components: { TranslationalStiffnessX: true, TranslationalStiffnessY: true, TranslationalStiffnessZ: 1e10 } };
    expect(structuralSupportKind(condition, 'IFC4')).toBe('spring');
    expect(structuralSupportKind(condition, 'IFC4X3')).toBe('spring');
  });
});

describe('structuralGlyphs on real files', () => {
  const fixture = (path: string) => resolve(REPO_ROOT, 'tests/models', path);
  const LSF = 'structural/ifc_structuralanalysisview/little_steel_frame-3D--Axis-Struc.ifc';
  const PORTAL = 'structural/analysis-models/portal_01.ifc';

  it('lists the fixtures in the committed manifest so CI fetches them', () => {
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'tests/models/manifest.json'), 'utf8')) as { files?: { path?: string }[] };
    const paths = (manifest.files ?? []).map((file) => file.path);
    expect(paths).toEqual(expect.arrayContaining([LSF, PORTAL]));
  });

  /**
   * IFC2X3, Axis export. Cross-checked against IfcOpenShell 0.8
   * (`ifcopenshell.util.placement`, connections whose AppliedCondition holds
   * any non-zero or true value): 12 supported nodes at these positions, and
   * these action counts per load group.
   */
  it('IFC2X3: little_steel_frame supports and loads match IfcOpenShell', async (ctx) => {
    if (!existsSync(fixture(LSF))) ctx.skip(`${LSF} missing — run \`pnpm fixtures\` to fetch it`);
    const { extraction, glyphs } = await glyphsOf(readFileSync(fixture(LSF)));
    const supports = glyphs.filter((g) => g.kind === 'support');
    const oracle: Record<number, number[]> = {
      2673: [12, 0, 0], 2964: [0, 3.7, 0], 3003: [0, 7.4, 0], 3042: [0, 0, 0], 3142: [12, 3.7, 0], 3181: [12, 7.4, 0],
      5127: [0, 0, 0], 5138: [12, 0, 0], 5149: [0, 3.7, 0], 5160: [12, 3.7, 0], 5171: [0, 7.4, 0], 5182: [12, 7.4, 0],
    };
    expect(supports.map((g) => g.source.expressId).sort()).toEqual(Object.keys(oracle).map(Number).sort());
    for (const g of supports) close(g.position, oracle[g.source.expressId]);
    // Translations 1e10 (rigid), a rotation 0 (free).
    expect(new Set(supports.map((g) => g.kind === 'support' && g.support))).toEqual(new Set(['pinned']));

    const drawnPerGroup = new Map<string, Set<number>>();
    const activityById = new Map(extraction.activities.map((a) => [a.expressId, a]));
    for (const g of glyphs) {
      for (const group of activityById.get(g.source.expressId)?.groupGlobalIds ?? []) {
        if (!drawnPerGroup.has(group)) drawnPerGroup.set(group, new Set());
        drawnPerGroup.get(group)!.add(g.source.expressId);
      }
    }
    const drawn = (group: string) => drawnPerGroup.get(group)?.size ?? 0;
    // IfcOpenShell action counts. The node-load group, the two full line-load
    // groups and the three temperature groups draw every action.
    const everyAction: Record<string, number> = {
      '3$S09L3RP1fu9lr967gWgW': 6, '1MRugb_xvBFAgkLUT2rfvw': 48, '07AGoiGJDCggIminrAdX2n': 34,
      '2EoMJ8Jk56Pf18$lSogZb7': 34, '3IBMmze65FyfhrBbW7l8Cb': 34, '085sCkdl15s9RrLar2W57S': 34,
    };
    for (const [group, count] of Object.entries(everyAction)) expect(drawn(group), group).toBe(count);
    // 'Einzellast 1' to '6', 3 point loads each on curve members with no vertex:
    // Axis writes the load's station along the member as an absolute placement
    // ((0.75, 0, 0) on a member from (1.5, 0, 5) to (3, 0, 5)), drawn 0.75 m along it (#9668).
    for (const group of ['2AT7Jgwef76PjTmlnENjOM', '0fo2OFoJvEMugp$nr9oxqX', '3RhOX$y7D03gBw6bO111w2', '2ixnNXJ3nBBQ$gF316Npuo', '0R$8A62z9FtQIVnfqEuRcB', '0bitbU6p52XfCkbmDraasy']) {
      expect(drawn(group), group).toBe(3);
    }
    close(glyphs.find((g) => g.source.expressId === 6293)?.position, [2.25, 0, 5]);
    // 'Linienlast Trapez', 48 varying actions, all drawn. #6212 runs from (0, 0, 6)
    // to (0.75, 0, 6), LinearForceZ 0 at its start and -3 at its end: arrows grow
    // along it, none at the zero end.
    expect(drawn('0l4zY_xY1AvOhV5E5oNNEy')).toBe(48);
    const trapezoid = glyphs.filter((g) => g.source.expressId === 6212);
    expect(trapezoid.map((g) => g.kind === 'force' && g.magnitude)).toEqual([0.75, 1.5, 2.25, 3]);
    trapezoid.forEach((g, i) => close(g.position, [0.1875 * (i + 1), 0, 6]));
    // 'Eigengewicht' (126) and 'EG' (176) are abstract IfcStructuralActions over a valueless IfcStructuralLoad.
    expect(drawn('1RhtNht1f9M83MFZVjDQIA')).toBe(0);
    expect(drawn('17_ftd5Hr9h9GMXuZAlLck')).toBe(0);
  });

  /**
   * IFC4 in inches (0.0254 m). Supports #236 at #232 (0,0,0) and #271 at #267
   * (192,0,0). Curve action #317 on member #296, edge #244 (0,0,120) to #277
   * (192,0,120), carries a configuration of two LinearForceZ = -100 values at
   * 96 and 192 along the member. Nine reactions are not drawn.
   */
  it('IFC4: portal_01 supports sit on the nodes and the load configuration on its stations', async (ctx) => {
    if (!existsSync(fixture(PORTAL))) ctx.skip(`${PORTAL} missing — run \`pnpm fixtures\` to fetch it`);
    const { glyphs } = await glyphsOf(readFileSync(fixture(PORTAL)));
    const supports = glyphs.filter((g) => g.kind === 'support');
    expect(supports.map((g) => [g.source.expressId, g.kind === 'support' && g.support])).toEqual([[236, 'fixed'], [271, 'fixed']]);
    close(supports[0].position, [0, 0, 0]);
    close(supports[1].position, [192 * 0.0254, 0, 0]);
    const loads = glyphs.filter((g) => g.kind !== 'support' && !g.reaction);
    expect(loads.map((g) => g.source.expressId)).toEqual([317, 317]);
    // Seven reactions draw; #2733 and #2753 are all-zero displacements.
    const reactions = glyphs.filter((g) => g.reaction);
    expect([...new Set(reactions.map((g) => g.source.expressId))].sort()).toEqual([2741, 2747, 2759, 2765, 2773, 2781, 2789]);
    // #2773 on the left column (0, 0, 0)-(0, 0, 120 in): Head at 0, Tail at 120.
    const ends = reactions.filter((g) => g.source.expressId === 2773 && g.kind === 'force');
    close(ends[0]?.position, [0, 0, 0]);
    close(ends[1]?.position, [0, 0, 120 * 0.0254]);
    close(loads[0].position, [96 * 0.0254, 0, 120 * 0.0254]);
    close(loads[1].position, [192 * 0.0254, 0, 120 * 0.0254]);
    for (const g of loads) {
      expect(g.kind === 'force' && [g.distribution, g.magnitude, g.relative]).toEqual(['linear', 100, 1]);
      close(g.kind === 'force' ? g.direction : undefined, [0, 0, -1]);
    }
  });
});

describe('face stations', () => {
  function inside([x, y]: readonly number[], polygon: readonly (readonly number[])[]): boolean {
    let hit = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i];
      const [xj, yj] = polygon[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  }

  it('places a notched face with no lattice point inside on the face, not at its centroid', () => {
    // C shape: the vertex average (0.54, 0.5) lies in the open notch, and no
    // point of the 3 x 3 lattice (1/6, 1/2, 5/6) is inside the 0.15-wide spine
    // or the 0.16-tall bands.
    const polygon: [number, number, number][] = [
      [0, 0, 0], [1, 0, 0], [1, 0.16, 0], [0.15, 0.16, 0], [0.15, 0.84, 0], [1, 0.84, 0], [1, 1, 0], [0, 1, 0],
    ];
    const stations = shapeStations({ kind: 'face', polygon });
    expect(stations).toHaveLength(1);
    for (const station of stations) expect(inside(station, polygon)).toBe(true);
    // Most clearance: the centre of the bottom or the top band (0.16 tall, they
    // tie), not the 0.15-wide spine.
    const [x, y, z] = stations[0];
    expect(z).toBeCloseTo(0);
    expect(x).toBeCloseTo(0.5);
    expect(Math.min(Math.abs(y - 0.08), Math.abs(y - 0.92))).toBeLessThan(1e-9);
  });

  it('anchors the single marker of a notched face on the face', () => {
    const polygon: [number, number, number][] = [
      [0, 0, 0], [1, 0, 0], [1, 0.16, 0], [0.15, 0.16, 0], [0.15, 0.84, 0], [1, 0.84, 0], [1, 1, 0], [0, 1, 0],
    ];
    const centre = shapeCentre({ kind: 'face', polygon });
    expect(inside(centre, polygon)).toBe(true);
    // A convex face keeps its centroid.
    close(shapeCentre({ kind: 'face', polygon: [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]] }), [1, 1, 0]);
  });

  it('places a notched face in a tilted, offset plane on that face', () => {
    // The C shape turned 30 degrees about x and moved to (5, -3, 2).
    const [c, sn] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
    const flat: [number, number][] = [[0, 0], [1, 0], [1, 0.16], [0.15, 0.16], [0.15, 0.84], [1, 0.84], [1, 1], [0, 1]];
    const toWorld = ([u, v]: readonly number[]): [number, number, number] => [5 + u, -3 + v * c, 2 + v * sn];
    const polygon = flat.map(toWorld);
    // The centre of a band, (0.5, 0.08) or (0.5, 0.92); the marker and the
    // only station agree on it.
    const stations = shapeStations({ kind: 'face', polygon });
    expect(stations).toHaveLength(1);
    const offBand = Math.min(...[[0.5, 0.08], [0.5, 0.92]].map((uv) => Math.hypot(...toWorld(uv).map((x, i) => x - stations[0][i]))));
    expect(offBand).toBeLessThan(1e-9);
    close(shapeCentre({ kind: 'face', polygon }), stations[0]);
  });

  it('anchors a face with a horizontal edge at mid-height on its widest part, in any orientation or winding', () => {
    // U shape: the notch's bottom edge sits at v = 0.5, the middle of the face,
    // and its vertex average (0.5, 0.625) lies in the notch. The bottom bar
    // (1 wide, 0.5 tall) has more clearance than an arm (0.3 wide), so the
    // anchor is its centre (0.5, 0.25).
    const flat: [number, number][] = [[0, 0], [1, 0], [1, 1], [0.7, 1], [0.7, 0.5], [0.3, 0.5], [0.3, 1], [0, 1]];
    for (const winding of [flat, [...flat].reverse()]) {
      for (let k = 0; k < 40; k++) {
        // A general orthonormal in-plane basis (e1, e2) and an offset origin.
        const [a, b] = [0.37 * k, 0.11 + 0.23 * k];
        const e1 = [Math.cos(a), Math.sin(a), 0];
        const e2 = [-Math.sin(a) * Math.cos(b), Math.cos(a) * Math.cos(b), Math.sin(b)];
        const o = [12.3, -45.6, 7.89];
        const at = (u: number, v: number) => [0, 1, 2].map((i) => o[i] + u * e1[i] + v * e2[i]) as [number, number, number];
        close(shapeCentre({ kind: 'face', polygon: winding.map(([u, v]) => at(u, v)) }), at(0.5, 0.25));
      }
    }
  });

  it('anchors an inverted T in its stem, not on its thin wide foot', () => {
    // Foot 2 wide and 0.001 tall under a stem 0.1 wide and 1 tall, off centre
    // so the vertex average (1.425, 0.25075) is outside. The foot is the widest
    // span but has 0.001 of clearance; the stem has 0.1.
    const polygon: [number, number, number][] = [
      [0, 0, 0], [2, 0, 0], [2, 0.001, 0], [1.9, 0.001, 0], [1.9, 1.001, 0], [1.8, 1.001, 0], [1.8, 0.001, 0], [0, 0.001, 0],
    ];
    close(shapeCentre({ kind: 'face', polygon }), [1.85, 0.501, 0]);
  });

  it('anchors a face whose rows are cut thin by vertices elsewhere at its most open point', () => {
    // A 1 x 0.3 base with an uneven sawtooth left side and ten thin teeth on
    // top. In the base its tallest rows (0.01 to 0.1, 0.2 to 0.29) hug its
    // bottom and top edges, so a width-or-row-height score anchors 0.055 from
    // one of them; the candidate farthest from every edge is mid-base, 0.125
    // clear.
    const saw: [number, number, number][] = [[0, 0.3, 0], [0.01, 0.29, 0], [0, 0.2, 0], [0.01, 0.15, 0], [0, 0.1, 0], [0.01, 0.01, 0]];
    const teeth: [number, number, number][] = [];
    for (let i = 9; i >= 0; i--) {
      const [l, r] = [i * 0.1 + 0.08, i * 0.1 + 0.1];
      teeth.push([r, 0.3, 0], [r, 1.3, 0], [l, 1.3, 0], [l, 0.3, 0]);
    }
    const polygon: [number, number, number][] = [[0, 0, 0], [1, 0, 0], ...teeth.slice(1), ...saw];
    const average = [0, 1].map((i) => polygon.reduce((sum, p) => sum + p[i], 0) / polygon.length);
    expect(inside(average, polygon)).toBe(false);
    const [x, y] = shapeCentre({ kind: 'face', polygon });
    expect(x).toBeGreaterThan(0.4);
    expect(x).toBeLessThan(0.6);
    expect(y).toBeGreaterThan(0.1);
    expect(y).toBeLessThan(0.2);
  });

  it('anchors a long, very thin notched face inside it, not on a corner', () => {
    // 1e4 long and 5e-6 tall, with a notch in its top edge that moves the
    // vertex average off the face.
    const h = 5e-6;
    const polygon: [number, number, number][] = [[0, 0, 0], [1e4, 0, 0], [1e4, h, 0], [9e3, h, 0], [9e3, h / 2, 0], [1e3, h / 2, 0], [1e3, h, 0], [0, h, 0]];
    // The best candidates (mid-length on the lower half, or mid-lobe on the
    // upper half) are all h / 4 clear of every edge.
    const centre = shapeCentre({ kind: 'face', polygon });
    expect(inside(centre, polygon)).toBe(true);
    const [u, v] = centre;
    const edgeDistance = polygon.map(([ax, ay], i) => {
      const [bx, by] = polygon[(i + 1) % polygon.length];
      const t = Math.max(0, Math.min(1, ((u - ax) * (bx - ax) + (v - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
      return Math.hypot(u - ax - t * (bx - ax), v - ay - t * (by - ay));
    });
    expect(Math.min(...edgeDistance)).toBeGreaterThan(h / 4 * (1 - 1e-6));
  });

  it('retains interior stations for a convex sliver', () => {
    const polygon: [number, number, number][] = [[0, 0, 0], [1, 1, 0], [0.99, 1, 0]];
    const stations = shapeStations({ kind: 'face', polygon });
    expect(stations.length).toBeGreaterThan(0);
    for (const [x, y, z] of stations) {
      expect(z).toBeCloseTo(0);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(1);
      expect(x).toBeGreaterThan(0.99 * y);
      expect(x).toBeLessThan(y);
    }
  });
});

// #9828: openings survive the source reader, placement and metre conversion.
it('keeps stations and markers out of face openings (#9828)', async () => {
  const opening = `
#200=IFCCARTESIANPOINT((500.,0.,750.));
#201=IFCCARTESIANPOINT((1500.,0.,750.));
#202=IFCCARTESIANPOINT((1500.,0.,2250.));
#203=IFCCARTESIANPOINT((500.,0.,2250.));
#204=IFCPOLYLOOP((#200,#201,#202,#203));
#205=IFCFACEBOUND(#204,.F.);
`;
  const { store } = await glyphsOf(new TextEncoder().encode(SYNTHETIC
    .replace('IFCFACESURFACE((#71)', 'IFCFACESURFACE((#71,#205)')
    .replace('ENDSEC;END-ISO', opening + 'ENDSEC;END-ISO')));
  const { ItemGeometryReader } = await import('./structural-item-geometry.js');
  const shape = new ItemGeometryReader(store).shape(76)!;
  expect(shape.kind).toBe('face');
  if (shape.kind !== 'face') return;
  expect(shape.innerBounds).toHaveLength(1);
  const positions = [...shapeStations(shape), shapeCentre(shape)];
  expect(positions.length).toBeGreaterThan(1);
  for (const [, y, z] of positions) {
    expect(y > 0.5 && y < 1.5 && z > 1.25 && z < 2.75).toBe(false);
  }
  // A thin rim misses every lattice station and forces the scanline fallback.
  const face: ItemShape = { kind: 'face', polygon: [[0,0,0],[6,0,0],[6,6,0],[0,6,0]],
    innerBounds: [[[0.1,0.1,0],[5.9,0.1,0],[5.9,5.9,0],[0.1,5.9,0]]] };
  for (const [x,y] of [...shapeStations(face), shapeCentre(face)]) {
    expect(x > 0.1 && x < 5.9 && y > 0.1 && y < 5.9).toBe(false);
  }
});

it('scales multi-group actions by their case, otherwise first group (#9828)', async () => {
  const { store, extraction } = await glyphsOf(new TextEncoder().encode(SYNTHETIC));
  const groups = extraction.loadGroups;
  const g1 = groups.find((g) => g.expressId === 110)!;
  const g2 = groups.find((g) => g.expressId === 111)!;
  g2.type = 'IfcStructuralLoadCase';
  const a = extraction.activities.find((a) => a.expressId === 81)!; // 5 N
  const b = extraction.activities.find((a) => a.expressId === 83)!; // 10 N
  a.groupGlobalIds = [g1.globalId, g2.globalId];
  b.groupGlobalIds = [g2.globalId];
  extraction.activities = [a,b];
  const relative = () => {
    const force = structuralGlyphs(store, extraction).find((g) => g.source.expressId === 81 && g.kind === 'force');
    return force && 'relative' in force ? force.relative : undefined;
  };
  expect(relative()).toBe(0.5);
  g2.type = 'IfcStructuralLoadGroup';
  expect(relative()).toBe(1);
});

describe('varying stations (#9937 review)', () => {
  it('draws every value at its own station, also between the usual edge stations', () => {
    // Nine values, the only non-zero one at 1/8 of the edge: between stations 0 and 0.25.
    const load = (z: number) => ({ expressId: 1, type: 'IfcStructuralLoadLinearForce', components: { LinearForceZ: z } });
    const loads = [0, -10, 0, 0, 0, 0, 0, 0, 0].map(load);
    const shape: ItemShape = { kind: 'edge', start: [0, 0, 0], end: [8, 0, 0] };
    const parts = varyingParts(shape, loads, () => true);
    const peak = parts.find((p) => p.load.components.LinearForceZ === -10);
    close(peak?.at, [1, 0, 0]);
  });

  it('refuses a varying action whose subsequent loads include an empty slot, rather than respace the rest', async () => {
    const ifc = `ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('v.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC2X3'));ENDSEC;DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCCARTESIANPOINT((4.,0.,0.));#3=IFCVERTEXPOINT(#1);#4=IFCVERTEXPOINT(#2);#5=IFCEDGE(#3,#4);
#6=IFCTOPOLOGYREPRESENTATION($,'Reference','Edge',(#5));#7=IFCPRODUCTDEFINITIONSHAPE($,$,(#6));
#10=IFCSTRUCTURALLOADLINEARFORCE($,0.,0.,-1.,0.,0.,0.);#11=IFCSTRUCTURALLOADLINEARFORCE($,0.,0.,-3.,0.,0.,0.);
#20=IFCSTRUCTURALLINEARACTIONVARYING(${id(20)},$,$,$,$,$,#7,#10,.GLOBAL_COORDS.,.F.,$,.TRUE_LENGTH.,$,(#11));
#21=IFCSTRUCTURALLINEARACTIONVARYING(${id(21)},$,$,$,$,$,#7,#10,.GLOBAL_COORDS.,.F.,$,.TRUE_LENGTH.,$,($,#11));
ENDSEC;END-ISO-10303-21;`;
    const { glyphs } = await glyphsOf(new TextEncoder().encode(ifc));
    // #20 draws -1 at the start growing to -3 at the end; #21's empty slot refuses it.
    const drawn = bySource(glyphs, 20);
    expect(drawn.map((g) => g.kind === 'force' && g.magnitude)).toEqual([1, 1.5, 2, 2.5, 3]);
    expect(bySource(glyphs, 21)).toEqual([]);
  });
});

