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
import { structuralSupportKind } from './structural-support-kind.js';
import { shapeCentre, shapeStations } from './structural-glyph-stations.js';

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
    bySource(glyphs, 93).forEach((g) => close(g.kind === 'force' ? g.direction : undefined, [-1, 0, 0]));
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

  it('marks temperature and displacement loads, skips reactions, and refuses a point load on a member', async () => {
    const { glyphs } = await glyphsOf(new TextEncoder().encode(SYNTHETIC));
    const [temperature] = bySource(glyphs, 97);
    expect(temperature.kind).toBe('temperature');
    close(temperature.position, [1, 1, 0.5]);
    const [displacement] = bySource(glyphs, 99);
    expect(displacement.kind).toBe('displacement');
    close(displacement.kind === 'displacement' ? displacement.direction : undefined, [0, 0, -1]);
    expect(bySource(glyphs, 100)).toEqual([]);
    // A5 is a point action on a curve member with no vertex of its own. It shares the
    // member's placement, whose origin is the member's start node: still no position.
    expect(bySource(glyphs, 101)).toEqual([]);
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
    expect(structuralSupportKind(node([-1, -1, -1, -1, -1, -1]))).toBe('fixed');
    expect(structuralSupportKind(node([1e10, 1e10, 1e10, 0, 0, 0]))).toBe('pinned');
    expect(structuralSupportKind(node([0, 0, -1]))).toBe('roller');
    expect(structuralSupportKind(node([1e10, 1e10, 5000]))).toBe('spring');
    expect(structuralSupportKind(node([0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(structuralSupportKind(node([]))).toBeNull();
    expect(structuralSupportKind(undefined)).toBeNull();
  });
  it('reads IFC4 face conditions, which have no rotations', () => {
    const face = { expressId: 2, type: 'IfcBoundaryFaceCondition', components: { TranslationalStiffnessByAreaX: true, TranslationalStiffnessByAreaY: true, TranslationalStiffnessByAreaZ: true } };
    expect(structuralSupportKind(face)).toBe('pinned');
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
    // ((0.75, 0, 0) on a member from (1.5, 0, 5) to (3, 0, 5)). A placement
    // origin is never taken as a position, so nothing is drawn.
    for (const group of ['2AT7Jgwef76PjTmlnENjOM', '0fo2OFoJvEMugp$nr9oxqX', '3RhOX$y7D03gBw6bO111w2', '2ixnNXJ3nBBQ$gF316Npuo', '0R$8A62z9FtQIVnfqEuRcB', '0bitbU6p52XfCkbmDraasy']) {
      expect(drawn(group), group).toBe(0);
    }
    // 'Linienlast Trapez', 48 varying actions: the 6 whose first value is zero draw nothing (stations are not read yet).
    expect(drawn('0l4zY_xY1AvOhV5E5oNNEy')).toBe(42);
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
    const loads = glyphs.filter((g) => g.kind !== 'support');
    expect(loads.map((g) => g.source.expressId)).toEqual([317, 317]);
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
    // point of the 3 x 3 lattice (1/6, 1/2, 5/6) is inside the 0.16-wide band.
    const polygon: [number, number, number][] = [
      [0, 0, 0], [1, 0, 0], [1, 0.16, 0], [0.16, 0.16, 0], [0.16, 0.84, 0], [1, 0.84, 0], [1, 1, 0], [0, 1, 0],
    ];
    const stations = shapeStations({ kind: 'face', polygon });
    expect(stations).toHaveLength(1);
    for (const station of stations) expect(inside(station, polygon)).toBe(true);
    // The widest span: halfway along the bottom or the top band (they tie).
    const [x, y, z] = stations[0];
    expect(z).toBeCloseTo(0);
    expect(x).toBeCloseTo(0.5);
    expect([0.08, 0.92].some((band) => Math.abs(y - band) < 1e-9)).toBe(true);
  });

  it('anchors the single marker of a notched face on the face', () => {
    const polygon: [number, number, number][] = [
      [0, 0, 0], [1, 0, 0], [1, 0.16, 0], [0.16, 0.16, 0], [0.16, 0.84, 0], [1, 0.84, 0], [1, 1, 0], [0, 1, 0],
    ];
    const centre = shapeCentre({ kind: 'face', polygon });
    expect(inside(centre, polygon)).toBe(true);
    // A convex face keeps its centroid.
    close(shapeCentre({ kind: 'face', polygon: [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]] }), [1, 1, 0]);
  });

  it('places a notched face in a tilted, offset plane on that face', () => {
    // The C shape turned 30 degrees about x and moved to (5, -3, 2).
    const [c, sn] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
    const flat: [number, number][] = [[0, 0], [1, 0], [1, 0.16], [0.16, 0.16], [0.16, 0.84], [1, 0.84], [1, 1], [0, 1]];
    const toWorld = ([u, v]: readonly number[]): [number, number, number] => [5 + u, -3 + v * c, 2 + v * sn];
    const polygon = flat.map(toWorld);
    // The widest span is a band, 0 to 1 at v = 0.08 or 0.92; the marker and the
    // only station agree on it.
    const stations = shapeStations({ kind: 'face', polygon });
    expect(stations).toHaveLength(1);
    const band = [toWorld([0.5, 0.08]), toWorld([0.5, 0.92])].find((p) => Math.hypot(...p.map((x, i) => x - stations[0][i])) < 1e-9);
    close(band, stations[0]);
    close(shapeCentre({ kind: 'face', polygon }), stations[0]);
  });

  it('anchors a face with a horizontal edge at mid-height on its widest part, in any orientation or winding', () => {
    // U shape: the notch's bottom edge sits at v = 0.5, the middle of the face,
    // and its vertex average (0.5, 0.625) lies in the notch. The widest span is
    // the bottom bar, so the anchor is (0.5, 0.25), well clear of every edge.
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
