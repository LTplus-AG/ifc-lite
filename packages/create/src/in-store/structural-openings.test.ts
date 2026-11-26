/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #9668: physical openings survive derivation and a STEP round trip.
import { existsSync, readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { IfcParser, extractStructuralOnDemand } from '@ifc-lite/parser';
import { ItemGeometryReader } from '../../../parser/src/structural-item-geometry.js';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { addStructuralSurfaceMemberToStore, resolveSpatialAnchor, readStructuralDerivationFacts, planStructuralDerivation, applyStructuralDerivation } from '../index.js';
import * as shapeModule from './structural-derive-shape.js';
import * as faceModule from './_structural-face.js';
import * as planModule from './structural-derive-plan.js';
import * as polygonModule from './polygon-2d.js';
import { plateOpenings, openingSection } from './structural-opening-section.js';
import { prepareStructuralFace } from './_structural-face.js';
import type { Vec3 } from './structural-derive-types.js';
const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',#4,'P',$,$,$,$,(#7),#9);
#2=IFCPERSON($,'Author',$,$,$,$,$,$);
#3=IFCORGANIZATION($,'Org',$,$,$);
#4=IFCOWNERHISTORY(#10,#11,$,.ADDED.,0,$,$,0);
#10=IFCPERSONANDORGANIZATION(#2,#3,$);
#11=IFCAPPLICATION(#3,'1','Test','Test');
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCAXIS2PLACEMENT3D(#5,$,$);
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#6,$);
#9=IFCUNITASSIGNMENT((#91));
#91=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCLOCALPLACEMENT($,#6);
#30=IFCBUILDINGSTOREY('0storey000000000000000',#4,'Level 0',$,$,#20,$,$,.ELEMENT.,0.);
#31=IFCRELAGGREGATES('0aggr00000000000000000',#4,$,$,#1,(#30));
ENDSEC;
END-ISO-10303-21;`;


const parse = (text: string) => new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
async function session(text = MODEL) {
  const store = await parse(text);
  const view = new MutablePropertyView(null, 'openings');
  const editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, 30);
  return { store, view, editor, anchor };
}
async function roundTrip(s: Awaited<ReturnType<typeof session>>) {
  const { content } = new StepExporter(s.store, s.view).export({ schema: 'IFC2X3', applyMutations: true });
  return parse(typeof content === 'string' ? content : new TextDecoder().decode(content));
}
const rectangle = (x: number, y: number, w: number, h: number, z = 0): Vec3[] => [[x,y,z],[x+w,y,z],[x+w,y+h,z],[x,y+h,z]];
const boundary = rectangle(0, 0, 10, 6);
const windows = [rectangle(1, 1, 2, 2), rectangle(6, 1, 2, 2)];

describe('surface opening builder', () => {
  it.each(['IFC2X3', 'IFC4', 'IFC4X3'])('%s writes two inner bounds and reads them as holes', async schema => {
    const s = await session(MODEL.replace('IFC2X3', schema));
    const result = addStructuralSurfaceMemberToStore(s.editor, s.anchor, { Boundary: boundary, Openings: windows });
    const parsed = await roundTrip(s);
    expect(extractStructuralOnDemand(parsed).members).toHaveLength(1);
    const shape = new ItemGeometryReader(parsed).shape(result.memberId);
    expect(shape?.kind).toBe('face');
    if (shape?.kind !== 'face') throw new Error('missing face');
    expect(shape.innerBounds).toHaveLength(2);
    expect(shape.innerBounds?.map(r => r.length)).toEqual([4, 4]);
    expect(s.editor.getNewEntities().filter(e => e.type === 'IfcFaceBound')).toHaveLength(2);
    const face = prepareStructuralFace(boundary, windows);
    for (const ring of face.openings) {
      const area = ring.reduce((s,p,i) => s + p[0]*ring[(i+1)%ring.length][1]-p[1]*ring[(i+1)%ring.length][0],0);
      expect(area).toBeLessThan(0);
    }
  });
  it('uses the outer plane tolerance and handles reversed, rotated loops', () => {
    const turn = (p: Vec3): Vec3 => [p[0] + 100, 20 - p[2], p[1] - 10];
    const outer = boundary.map(turn).reverse();
    const holes = windows.map(r => r.map(turn));
    expect(prepareStructuralFace(outer, holes).openings).toHaveLength(2);
    const noise = windows[0].map(p => [p[0], p[1], 1e-7] as Vec3);
    expect(prepareStructuralFace(boundary, [noise]).openings[0].every(p => p[2] === 0)).toBe(true);
  });
  it('rejects an edge crossing a concave boundary even when all vertices are inside', () => {
    const outer: Vec3[] = [[0,0,0],[6,0,0],[6,6,0],[4,6,0],[4,2,0],[2,2,0],[2,6,0],[0,6,0]];
    expect(() => prepareStructuralFace(outer, [rectangle(1,1,4,4)])).toThrow('opening must lie strictly inside boundary');
  });
  const invalid: [string, Vec3[][], string][] = [
    ['short', [[[1,1,0],[2,1,0]]], 'at least three finite boundary points'],
    ['off plane', [rectangle(1,1,1,1,0.01)], 'opening must be coplanar with boundary'],
    ['self crossing', [[[1,1,0],[3,3,0],[1,3,0],[3,1,0],[4,2,0]]], 'boundary must not self-intersect'],
    ['outside', [rectangle(9,1,2,2)], 'opening must lie strictly inside boundary'],
    ['touches', [rectangle(0,1,2,2)], 'opening must lie strictly inside boundary'],
    ['overlaps', [windows[0], rectangle(2,2,2,2)], 'openings must not overlap or touch'],
    ['nested', [windows[0], rectangle(1.2,1.2,0.5,0.5)], 'openings must not overlap or touch'],
    ['touching holes', [windows[0], rectangle(3,1,1,1)], 'openings must not overlap or touch'],
    ['zero area', [[[1,1,0],[2,1,0],[3,1,0]]], 'degenerate boundary'],
  ];
  it.each(invalid)('rejects %s before writing', async (_name, Openings, message) => {
    const s = await session();
    const before = s.editor.getNewEntities().length;
    expect(() => addStructuralSurfaceMemberToStore(s.editor, s.anchor, { Boundary: boundary, Openings })).toThrow(message);
    expect(s.editor.getNewEntities()).toHaveLength(before);
  });
});

/** Wall extruded upwards; openings extruded across its thickness. Slab has a vertical stair opening. */
function physicalModel(planOpenings = false) {
  const records: string[] = [];
  let id = 100;
  const add = (s: string) => { records.push(`#${++id}=${s};`); return id; };
  const pt = (p: number[]) => add(`IFCCARTESIANPOINT((${p.join(',')}))`);
  const dir = (p: number[]) => add(`IFCDIRECTION((${p.join(',')}))`);
  const solid = (origin: number[], axis: number[], w: number, h: number, depth: number) => {
    const profile = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,$,${w},${h})`);
    const pos = add(`IFCAXIS2PLACEMENT3D(#${pt(origin)},#${dir(axis)},#${dir([1,0,0])})`);
    const body = add(`IFCEXTRUDEDAREASOLID(#${profile},#${pos},#${dir([0,0,1])},${depth})`);
    const rep = add(`IFCSHAPEREPRESENTATION(#7,'Body','SweptSolid',(#${body}))`);
    return add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
  };
  const product = (type: string, name: string, shape: number | null) => add(`${type}('0${String(id).padStart(21,'0')}',#4,'${name}',$,$,#20,${shape ? '#'+shape : '$'},$${type==='IFCSLAB'?',.FLOOR.':''})`);
  const wall = product('IFCWALL','wall',solid([0,planOpenings ? 0.165 : 0,0],[0,0,1],10,planOpenings ? 0.33 : 0.4,4));
  const slab = product('IFCSLAB','slab',solid([20,0,0],[0,0,1],10,8,0.3));
  const opening = (host: number, name: string, origin: number[], axis = [0,-1,0], depth = 0.6, w=1,h=1, unreadable=false) => {
    const opening = product('IFCOPENINGELEMENT', name, unreadable ? null : solid(origin,axis,w,h,depth));
    add(`IFCRELVOIDSELEMENT('0${String(id).padStart(21,'0')}',#4,$,$,#${host},#${opening})`);
    return opening;
  };
  if (planOpenings) {
    opening(wall,'plan window',[1,0.165,0.75],[0,0,1],1.82,0.91,0.37);
    opening(wall,'plan recess',[-1,0.165,0.75],[0,0,1],1.82,0.91,0.1);
    // U profile: the mid-plane crosses its two legs, giving two intervals.
    const points = [[-3,-0.3],[-1,-0.3],[-1,0.3],[-1.5,0.3],[-1.5,-0.25],[-2.5,-0.25],[-2.5,0.3],[-3,0.3],[-3,-0.3]];
    const curve = add(`IFCPOLYLINE((${points.map(p => '#'+pt(p)).join(',')}))`);
    const profile = add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#${curve})`);
    const pos = add(`IFCAXIS2PLACEMENT3D(#${pt([0,0,0.75])},$,$)`);
    const body = add(`IFCEXTRUDEDAREASOLID(#${profile},#${pos},#${dir([0,0,1])},1.82)`);
    const rep = add(`IFCSHAPEREPRESENTATION(#7,'Body','SweptSolid',(#${body}))`);
    const shape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
    const cut = product('IFCOPENINGELEMENT','two intervals',shape);
    add(`IFCRELVOIDSELEMENT('0twointervals0000000000',#4,$,$,#${wall},#${cut})`);
  }
  opening(wall,'window1',[-2,0.3,2]);
  opening(wall,'window2',[2,0.3,2]);
  opening(wall,'door',[0,0.3,1],[0,-1,0],0.6,1,2);
  opening(wall,'oblique',[3,0.3,2],[0,-1,0.1]);
  opening(wall,'recess',[-3,0.3,2],[0,-1,0],0.2);
  opening(wall,'overlap',[-2,0.3,2]);
  opening(wall,'unreadable',[0,0,0],[0,-1,0],0.6,1,1,true);
  opening(slab,'stair',[20,0,-0.1],[0,0,1],0.5,2,3);
  add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('0contain00000000000000',#4,$,$,(#${wall},#${slab}),#30)`);
  return MODEL.replace('ENDSEC;\nEND-ISO', records.join('\n')+'\nENDSEC;\nEND-ISO');
}

describe('derive physical openings', () => {
  it('carries a through-opening swept 0.8 degrees off a 0.4 m slab normal at 2 mm tolerance', async () => {
    const s = await session(physicalModel());
    const facts = readStructuralDerivationFacts(s.store, s.editor);
    const slab = facts.elements.find(e => e.type === 'IfcSlab')!;
    slab.prism!.extrusion = [0, 0, 0.4];
    const angle = 0.8 * Math.PI / 180;
    slab.openings![0].prism!.extrusion = [0.6 * Math.tan(angle), 0, 0.6];
    const plan = planStructuralDerivation(facts, { tolerance: 0.002 });
    expect(plan.surfaceMembers.find(m => m.elementId === slab.expressId)!.openings).toHaveLength(1);
    expect(plan.report.skippedOpenings.some(o => o.hostId === slab.expressId)).toBe(false);
  });
  it('skips an opening with a voided arbitrary profile instead of cutting its full outer outline', async () => {
    // Replace the existing arbitrary U profile with a closed rectangle and an inner loop.
    const text = physicalModel(true).replace(/IFCARBITRARYCLOSEDPROFILEDEF\(.AREA.,\$,#[0-9]+\)/,
      'IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#90001,(#90002))')
      .replace('ENDSEC;\nEND-ISO', `
#90001=IFCPOLYLINE((#90003,#90004,#90005,#90006,#90003));
#90002=IFCPOLYLINE((#90007,#90008,#90009,#90010,#90007));
#90003=IFCCARTESIANPOINT((-3.,-0.3));
#90004=IFCCARTESIANPOINT((-1.,-0.3));
#90005=IFCCARTESIANPOINT((-1.,0.3));
#90006=IFCCARTESIANPOINT((-3.,0.3));
#90007=IFCCARTESIANPOINT((-2.5,-0.1));
#90008=IFCCARTESIANPOINT((-1.5,-0.1));
#90009=IFCCARTESIANPOINT((-1.5,0.1));
#90010=IFCCARTESIANPOINT((-2.5,0.1));
ENDSEC;\nEND-ISO`);
    const s = await session(text);
    const facts = readStructuralDerivationFacts(s.store, s.editor);
    const wall = facts.elements.find(e => e.type === 'IfcWall')!;
    wall.openings = wall.openings!.filter(o => o.name === 'two intervals');
    expect(wall.openings[0].prism).toMatchObject({ outlineExact: true, profileHasVoids: true });
    const plan = planStructuralDerivation(facts);
    expect(plan.surfaceMembers.find(m => m.elementId === wall.expressId)!.openings).toEqual([]);
    expect(plan.report.skippedOpenings).toMatchObject([{ reason: 'opening-profile-has-voids' }]);
  });
  it.each([
    ['IFCRECTANGLEHOLLOWPROFILEDEF(.AREA.,$,#90011,2.,0.6,0.1,$,$)', 'opening-profile-has-voids'],
    ['IFCROUNDEDRECTANGLEPROFILEDEF(.AREA.,$,#90011,2.,0.6,0.1)', 'unsupported-opening-section'],
  ])('skips %s instead of cutting a hole larger than the physical opening', async (profile, reason) => {
    const text = physicalModel(true).replace(/IFCARBITRARYCLOSEDPROFILEDEF\(.AREA.,\$,#[0-9]+\)/, profile)
      .replace('ENDSEC;\nEND-ISO', `
#90011=IFCAXIS2PLACEMENT2D(#90012,$);
#90012=IFCCARTESIANPOINT((-2.,0.));
ENDSEC;\nEND-ISO`);
    const s = await session(text);
    const facts = readStructuralDerivationFacts(s.store, s.editor);
    const wall = facts.elements.find(e => e.type === 'IfcWall')!;
    wall.openings = wall.openings!.filter(o => o.name === 'two intervals');
    expect(wall.openings[0].prism?.outlineExact).toBe(true);
    const plan = planStructuralDerivation(facts);
    expect(plan.surfaceMembers.find(m => m.elementId === wall.expressId)!.openings).toEqual([]);
    expect(plan.report.skippedOpenings).toMatchObject([{ reason }]);
  });
  it('treats Openings: null from a JSON caller as no openings', () => {
    expect(prepareStructuralFace(boundary, null).openings).toEqual([]);
  });
  it('reports a missing voiding entity as unreadable', async () => {
    const s = await session(physicalModel().replace(/#(\d+)=IFCOPENINGELEMENT[^;]+;/g, ''));
    const facts = readStructuralDerivationFacts(s.store, s.editor);
    expect(facts.elements.flatMap(e => e.openings ?? []).every(o => o.type === null && o.shapeIssue === 'missing entity')).toBe(true);
    expect(planStructuralDerivation(facts).report.skippedOpenings).toHaveLength(8);
    expect(planStructuralDerivation(facts).report.skippedOpenings.every(o => o.reason === 'unreadable-opening')).toBe(true);
  });
  it('carries a plan window swept vertically at its original sill height', async () => {
    const s = await session(physicalModel(true));
    const facts = readStructuralDerivationFacts(s.store, s.editor);
    const wall = facts.elements.find(e => e.type === 'IfcWall')!;
    wall.openings = wall.openings!.filter(o => o.name === 'plan window');
    const plan = planStructuralDerivation(facts);
    const holes = plan.surfaceMembers.find(m => m.elementId === wall.expressId)!.openings!;
    expect(holes).toHaveLength(1);
    expect(holes[0]).toHaveLength(4);
    for (const [axis, min, max] of [[0,0.545,1.455],[1,0.165,0.165],[2,0.75,2.57]]) {
      expect(Math.min(...holes[0].map(p => p[axis]))).toBeCloseTo(min, 8);
      expect(Math.max(...holes[0].map(p => p[axis]))).toBeCloseTo(max, 8);
    }
    expect(plan.report.skippedOpenings).toEqual([]);
  });
  it('rejects a section that shifts between the two wall faces', async () => {
    const s = await session(physicalModel(true));
    const facts = readStructuralDerivationFacts(s.store, s.editor);
    const wall = facts.elements.find(e => e.type === 'IfcWall')!;
    wall.openings = wall.openings!.filter(o => o.name === 'plan window');
    const prism = wall.openings[0].prism!;
    prism.outline = prism.outline.map(([x,y,z]) => [x + 2 * y, y, z]);
    const plan = planStructuralDerivation(facts);
    expect(plan.surfaceMembers.find(m => m.elementId === wall.expressId)!.openings).toEqual([]);
    expect(plan.report.skippedOpenings[0].detail).toContain('section changes across plate faces');
  });
  it.each([['plan recess','not through'], ['two intervals','2 intervals']])('skips %s with its section reason', async (name, reason) => {
    const s = await session(physicalModel(true));
    const facts = readStructuralDerivationFacts(s.store, s.editor);
    const wall = facts.elements.find(e => e.type === 'IfcWall')!;
    wall.openings = wall.openings!.filter(o => o.name === name);
    const plan = planStructuralDerivation(facts);
    expect(plan.surfaceMembers.find(m => m.elementId === wall.expressId)!.openings).toEqual([]);
    expect(plan.report.skippedOpenings).toHaveLength(1);
    expect(plan.report.skippedOpenings[0].detail).toContain(reason);
  });
  it('uses the derive margin at the edge and refuses a shallow recess near the back face', async () => {
    const s = await session(physicalModel());
    const facts = readStructuralDerivationFacts(s.store, s.editor);
    const wall = facts.elements.find(e => e.type === 'IfcWall')!;
    const first = wall.openings![0];
    // 2 cm clearance is inside the builder, but within the 5 cm derive margin.
    first.prism!.outline = first.prism!.outline.map(p => [p[0], p[1], p[2] - 1.48]);
    const recess = wall.openings!.find(o => o.name === 'recess')!;
    recess.prism!.extrusion = [0, -0.44, 0]; // ends 6 cm before the back face (outside derive tolerance)
    const plan = planStructuralDerivation(facts);
    expect(plan.report.skippedOpenings.find(s => s.name === 'window1')?.detail).toContain('strictly inside');
    expect(plan.report.skippedOpenings.find(s => s.name === 'recess')?.detail).toContain('not through');
  });
  it('carries two through-windows and a stair opening, reporting every rejected opening', async () => {
    const s = await session(physicalModel());
    const facts = readStructuralDerivationFacts(s.store, s.editor);
    const plan = planStructuralDerivation(facts);
    expect(plan.surfaceMembers.map(m => [facts.elements.find(e => e.expressId === m.elementId)?.type, m.openings!.length])).toEqual([['IfcSlab',1],['IfcWall',2]]);
    expect(plan.report.skippedOpenings.map(s => [s.name, s.detail])).toEqual([
      ['door','Structural Face: opening must lie strictly inside boundary'],
      ['oblique','opening extrusion is oblique to the plate normal (more than 1 degree)'],
      ['recess','opening does not span the plate thickness (not through)'],
      ['overlap','Structural Face: openings must not overlap or touch'],
      ['unreadable','no Body representation'],
    ]);
    expect(plan.report.skipped).toEqual([]);
    expect(plan.report.counts.skipped).toBe(0);
    expect(plan.report.counts.skippedOpenings).toBe(5);
    expect(plan.report.skippedOpenings.every(s => facts.elements.some(e => e.expressId === s.hostId && e.openings?.some(o => o.expressId === s.openingId)))).toBe(true);
    applyStructuralDerivation(s.editor, s.store, plan);
    const parsed = await roundTrip(s);
    const members = extractStructuralOnDemand(parsed).members;
    expect(members).toHaveLength(2);
    expect(members.map(m => {
      const shape = new ItemGeometryReader(parsed).shape(m.expressId);
      return shape?.kind === 'face' ? shape.innerBounds?.length : -1;
    })).toEqual([1,2]);
  });
});

describe('opening review regressions', () => {
  it('carries the extrusion-following mid-plane section of a distant nearly normal profile', () => {
    const shift = Math.tan(0.9 * Math.PI / 180);
    const result = openingSection({ outline: rectangle(1,1,1,1,-1), extrusion: [2*shift,0,2], outlineExact: true }, [0,0,0], [0,0,1], 0.3, 0.01);
    expect(Array.isArray(result)).toBe(true);
    if (typeof result === 'string') throw new Error(result);
    rectangle(1+shift,1,1,1).forEach((p,i) => p.forEach((v,k) => expect(result[i][k]).toBeCloseTo(v, 10)));
  });
  it('reports zero-length opening extrusion as degenerate', () => {
    expect(openingSection({ outline: windows[0], extrusion: [0,0,0], outlineExact: true }, [0,0,0], [0,0,1], 0.3, 0.01)).toContain('degenerate');
  });
  it('deduplicates repeated void relationships per host', async () => {
    const source = physicalModel();
    const relation = source.match(/#\d+=IFCRELVOIDSELEMENT[^;]+;/)![0];
    const s = await session(source.replace('ENDSEC;\nEND-ISO', relation.replace(/^#\d+=/, '#990000=') + '\nENDSEC;\nEND-ISO'));
    const facts = readStructuralDerivationFacts(s.store,s.editor);
    expect(facts.elements.find(e => e.type === 'IfcWall')!.openings).toHaveLength(7);
    const plan = planStructuralDerivation(facts);
    expect(plan.surfaceMembers.reduce((n,m) => n+m.openings!.length,0)).toBe(3);
    expect(plan.report.skippedOpenings.filter(o => o.name === 'window1')).toEqual([]);
  });
  it('keeps slab openings when facts use skip and the planner uses include (#9668)', async () => {
    const s = await session(physicalModel());
    const facts = readStructuralDerivationFacts(s.store,s.editor);
    const slab = facts.elements.find(e => e.type === 'IfcSlab')!;
    expect(slab.openings).toHaveLength(1);
    const plan = planStructuralDerivation(facts, { whenLoadBearingUnknown: 'include' });
    expect(plan.surfaceMembers.find(m => m.elementId === slab.expressId)!.openings).toHaveLength(1);
  });
  it('retains opening facts for an unidealisable host (#9668)', async () => {
    const s = await session(physicalModel());
    const original = shapeModule.readElementShape;
    const read = vi.spyOn(shapeModule, 'readElementShape').mockImplementation((reader,id,metres,axis) => {
      if (reader.entity(id)?.type.toUpperCase() === 'IFCWALL') return { shapeIssue: 'unreadable host' };
      return original(reader,id,metres,axis);
    });
    try {
      const facts = readStructuralDerivationFacts(s.store,s.editor);
      expect(facts.elements.find(e => e.type === 'IfcWall')!.openings).toHaveLength(7);
      expect(read.mock.calls.filter(call => call[3] === false)).toHaveLength(8);
    } finally { read.mockRestore(); }
  });
  it('identifies a malformed held-plan ring as a bad opening of its host', async () => {
    const s = await session(physicalModel());
    const plan = planStructuralDerivation(readStructuralDerivationFacts(s.store,s.editor));
    const member = plan.surfaceMembers[0];
    member.openings = [windows[0].slice(0,2)];
    expect(() => applyStructuralDerivation(s.editor,s.store,plan)).toThrow(`element #${member.elementId} has a bad opening 1`);
    expect(s.editor.getNewEntities()).toHaveLength(0);
  });
  it.each([null, {}, 42, 'rings'])('refuses non-array held-plan openings %s with plan-again guidance (#9668)', async openings => {
    const s = await session(physicalModel());
    const plan = planStructuralDerivation(readStructuralDerivationFacts(s.store, s.editor));
    const member = plan.surfaceMembers[0];
    // @ts-expect-error deliberately malformed held plan from an untyped caller
    member.openings = openings;
    expect(() => applyStructuralDerivation(s.editor, s.store, plan)).toThrow(`element #${member.elementId} has openings that are not an array; plan again`);
    expect(s.editor.getNewEntities()).toHaveLength(0);
  });
  it.each([[0.04, -0.15], [0.06, -0.15], [0.04, 0.15], [0.06, 0.15]])('projects a column onto a diagonal wall: edge clearance %s, plane offset %s (#9668)', async (clearance, offset) => {
    const s = await session(physicalModel());
    const facts = readStructuralDerivationFacts(s.store, s.editor);
    const wall = facts.elements.find(e => e.type === 'IfcWall')!;
    wall.openings = wall.openings!.filter(o => o.name === 'window1');
    // Rotate the wall and its opening 45 degrees in plan.
    const rotate = ([x,y,z]: Vec3): Vec3 => [(x-y)/Math.SQRT2, (x+y)/Math.SQRT2, z];
    for (const prism of [wall.prism!, wall.openings[0].prism!]) {
      prism.outline = prism.outline.map(rotate);
      prism.extrusion = rotate(prism.extrusion);
    }
    // 15 cm along the normal; projection is just inside the window's left edge.
    facts.elements.push({ expressId: 99999, type: 'IfcColumn', name: null, storeyId: 30, loadBearing: true, idealised: false,
      axis: [rotate([-2.5+clearance,offset,-3]), rotate([-2.5+clearance,offset,2])] });
    const plan = planStructuralDerivation(facts);
    const top = plan.curveMembers.find(m => m.elementId === 99999)!.endNode;
    expect(plan.report.unconnectedEnds.some(e => e.node === top && e.landsOn === 'surface-member')).toBe(clearance < 0.05);
  });
  it('labels a rejected ring by its input index without repeating the face prefix', async () => {
    const s = await session(physicalModel());
    const facts = readStructuralDerivationFacts(s.store,s.editor);
    const wall = facts.elements.find(e => e.type === 'IfcWall')!;
    wall.openings = wall.openings!.filter(o => ['recess','overlap'].includes(o.name!));
    const prism = wall.openings[1].prism!;
    prism.outline = prism.outline.map((p,i) => [p[0]+i, p[1], 2]);
    const rejected = planStructuralDerivation(facts).report.skippedOpenings;
    expect(rejected[1].detail).toMatch(/^Structural Face: opening 2: (?!Structural Face:)/);
    expect(rejected[1].reason).toBe('invalid-opening-ring');
  });
  it.each([[-1, true],[-0.98, true],[-0.9, false]])('treats slab opening edge x=%s with derive clearance as touching=%s', async (x, touching) => {
    const s = await session(physicalModel());
    const facts = readStructuralDerivationFacts(s.store,s.editor);
    facts.elements.push({ expressId: 99999, type: 'IfcColumn', name: null, storeyId: 30, loadBearing: true, idealised: false, axis: [[20+x,0,-3],[20+x,0,0.15]] });
    const plan = planStructuralDerivation(facts);
    const top = plan.curveMembers.find(m => m.elementId === 99999)!.endNode;
    expect(plan.report.unconnectedEnds.some(e => e.node === top && e.landsOn === 'surface-member')).toBe(touching);
  });

  it('reads IfcOpeningStandardCase and reports unsupported voiding types separately', async () => {
    const text = physicalModel().replace(/IFCOPENINGELEMENT/g, 'IFCOPENINGSTANDARDCASE');
    const s = await session(text);
    const facts = readStructuralDerivationFacts(s.store, s.editor);
    expect(facts.elements.flatMap(e => e.openings ?? [])).toHaveLength(8);
    expect(planStructuralDerivation(facts).surfaceMembers.reduce((n,m) => n+m.openings!.length,0)).toBe(3);
    const bad = await session(text.replace(/IFCOPENINGSTANDARDCASE/g, 'IFCVOIDINGFEATURE'));
    const plan = planStructuralDerivation(readStructuralDerivationFacts(bad.store, bad.editor));
    expect(plan.report.skipped).toEqual([]);
    expect(plan.report.skippedOpenings).toHaveLength(8);
    expect(plan.report.skippedOpenings.every(o => o.reason === 'unsupported-voiding-type' && o.detail === 'unsupported voiding type IfcVoidingFeature')).toBe(true);
  });
  it.each(['normal', 'in-plane'])('uses length tolerance for a slightly short %s opening', async kind => {
    const s = await session(physicalModel(kind === 'in-plane'));
    const facts = readStructuralDerivationFacts(s.store, s.editor);
    const wall = facts.elements.find(e => e.type === 'IfcWall')!;
    wall.openings = wall.openings!.filter(o => o.name === (kind === 'normal' ? 'window1' : 'plan window'));
    const prism = wall.openings[0].prism!;
    if (kind === 'normal') {
      prism.outline = prism.outline.map(([x,,z]) => [x,0.1998,z]);
      prism.extrusion = [0,-0.3996,0];
    } else {
      prism.outline = prism.outline.map(([x,y,z]) => [x,0.165 + (y > 0.165 ? 1 : -1) * (0.33 - 1e-8)/2,z]);
    }
    const plan = planStructuralDerivation(facts, { tolerance: 0.001 });
    expect(plan.surfaceMembers.find(m => m.elementId === wall.expressId)!.openings).toHaveLength(1);
    expect(plan.report.skippedOpenings).toEqual([]);
  });
  it('accepts a slightly short opening in a slab extruded two degrees off normal', async () => {
    const s = await session(physicalModel());
    const facts = readStructuralDerivationFacts(s.store, s.editor);
    const slab = facts.elements.find(e => e.type === 'IfcSlab')!;
    const angle = 2 * Math.PI/180;
    slab.prism!.extrusion = [0.3*Math.sin(angle),0,0.3*Math.cos(angle)];
    const cut = slab.openings![0].prism!;
    cut.outline = cut.outline.map(([x,y]) => [x,y,0]);
    cut.extrusion = [0,0,0.3*Math.cos(angle)];
    const plan = planStructuralDerivation(facts, { tolerance: 0.001 });
    expect(plan.surfaceMembers.find(m => m.elementId === slab.expressId)!.openings).toHaveLength(1);
  });
  it('leaves a column top inside a slab opening free without claiming it rests on the slab', async () => {
    const s = await session(physicalModel());
    const facts = readStructuralDerivationFacts(s.store, s.editor);
    facts.elements.push({ expressId: 99999, type: 'IfcColumn', name: null, storeyId: 30, loadBearing: true, idealised: false, axis: [[20,0,-3],[20,0,0.15]] });
    const plan = planStructuralDerivation(facts);
    const top = plan.curveMembers.find(m => m.elementId === 99999)!.endNode;
    expect(plan.report.freeEnds).toContain(top);
    expect(plan.report.unconnectedEnds.filter(e => e.node === top)).toEqual([]);
  });
  it('applies a held plain plan with no openings field', async () => {
    const s = await session(physicalModel());
    const plan = planStructuralDerivation(readStructuralDerivationFacts(s.store,s.editor));
    plan.surfaceMembers.forEach(m => Reflect.deleteProperty(m, 'openings'));
    expect(() => applyStructuralDerivation(s.editor,s.store,plan)).not.toThrow();
  });
  it.each([{}, 'x'])('validates a non-array Openings value %s before emitting', async Openings => {
    const s = await session();
    const before = s.editor.getNewEntities().length;
    // Deliberately malformed plain data from an untyped caller.
    // @ts-expect-error testing runtime validation
    expect(() => addStructuralSurfaceMemberToStore(s.editor,s.anchor,{ Boundary: boundary, Openings })).toThrow(/^Structural Face: Openings must be an array/);
    expect(s.editor.getNewEntities()).toHaveLength(before);
  });
});


describe('shared opening helpers', () => {
  it('reuses the checked host face and returns early when no openings exist', async () => {
    const s = await session(physicalModel());
    const facts = readStructuralDerivationFacts(s.store,s.editor);
    facts.elements.forEach(e => { e.openings = []; });
    const prepare = vi.spyOn(faceModule, 'prepareStructuralFace');
    try {
      expect(planStructuralDerivation(facts).surfaceMembers).toHaveLength(2);
      expect(prepare).toHaveBeenCalledTimes(2);
      // An absent openings collection needs no prepared face at all.
      expect(plateOpenings({ ...facts.elements[0], openings: undefined }, { boundary: [], thickness: 0 }, undefined!, 0.01, [])).toEqual([]);
    } finally { prepare.mockRestore(); }
  });
  it('shares role classification with facts and pointInPolygon with profile sections', async () => {
    const s = await session(physicalModel(true));
    const role = vi.spyOn(planModule, 'roleOf');
    const polygon = vi.spyOn(polygonModule, 'pointInPolygon');
    try {
      const facts = readStructuralDerivationFacts(s.store,s.editor);
      expect(role).toHaveBeenCalledWith('IfcWall');
      const wall = facts.elements.find(e => e.type === 'IfcWall')!;
      wall.openings = wall.openings!.filter(o => o.name === 'plan window');
      const calls = polygon.mock.calls.length;
      openingSection(wall.openings[0].prism!, [0,0.165,0], [0,1,0], 0.33, 0.05);
      expect(polygon.mock.calls.length).toBeGreaterThan(calls);
    } finally { role.mockRestore(); polygon.mockRestore(); }
  });
});


const brickHouse = new URL('../../../../tests/models/ara3d/ISSUE_171_IfcSurfaceCurveSweptAreaSolid.ifc', import.meta.url);
if (!existsSync(brickHouse)) console.warn('skip: brick-house fixture missing; run `pnpm fixtures`');
it.skipIf(!existsSync(brickHouse))('keeps the brick-house result: 16 windows after stripping authored structural entities in memory', async () => {
  const source = readFileSync(brickHouse, 'utf8');
  const physical = source.replace(/^#\d+=IFC(?:STRUCTURAL\w*|RELCONNECTSSTRUCTURAL\w*)\([\s\S]*?;\r?\n/gm, '');
  const store = await parse(physical);
  const s = { store, editor: new StoreEditor(store, new MutablePropertyView(null, 'brick-house')) };
  expect(extractStructuralOnDemand(s.store).members).toHaveLength(0);
  const plan = planStructuralDerivation(readStructuralDerivationFacts(s.store,s.editor));
  expect(plan.surfaceMembers.reduce((n,m) => n + m.openings!.length,0)).toBe(16);
});
