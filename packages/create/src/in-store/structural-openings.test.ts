/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #9668: physical openings survive derivation and a STEP round trip.
import { describe, it, expect } from 'vitest';
import { IfcParser, extractStructuralOnDemand } from '@ifc-lite/parser';
import { ItemGeometryReader } from '../../../parser/src/structural-item-geometry.js';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { addStructuralSurfaceMemberToStore, resolveSpatialAnchor, readStructuralDerivationFacts, planStructuralDerivation, applyStructuralDerivation } from '../index.js';
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
function physicalModel() {
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
  const wall = product('IFCWALL','wall',solid([0,0,0],[0,0,1],10,0.4,4));
  const slab = product('IFCSLAB','slab',solid([20,0,0],[0,0,1],10,8,0.3));
  const opening = (host: number, name: string, origin: number[], axis = [0,-1,0], depth = 0.6, w=1,h=1, unreadable=false) => {
    const opening = product('IFCOPENINGELEMENT', name, unreadable ? null : solid(origin,axis,w,h,depth));
    add(`IFCRELVOIDSELEMENT('0${String(id).padStart(21,'0')}',#4,$,$,#${host},#${opening})`);
    return opening;
  };
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
  it('uses the derive margin at the edge and refuses a shallow recess near the back face', async () => {
    const s = await session(physicalModel());
    const facts = readStructuralDerivationFacts(s.store, s.editor);
    const wall = facts.elements.find(e => e.type === 'IfcWall')!;
    const first = wall.openings![0];
    // 2 cm clearance is inside the builder, but within the 5 cm derive margin.
    first.prism!.outline = first.prism!.outline.map(p => [p[0], p[1], p[2] - 1.48]);
    const recess = wall.openings!.find(o => o.name === 'recess')!;
    recess.prism!.extrusion = [0, -0.49, 0]; // ends 1 cm before the back face
    const plan = planStructuralDerivation(facts);
    expect(plan.report.skipped.find(s => s.name === 'window1')?.detail).toContain('strictly inside');
    expect(plan.report.skipped.find(s => s.name === 'recess')?.detail).toContain('not through');
  });
  it('carries two through-windows and a stair opening, reporting every rejected opening', async () => {
    const s = await session(physicalModel());
    const facts = readStructuralDerivationFacts(s.store, s.editor);
    const plan = planStructuralDerivation(facts);
    expect(plan.surfaceMembers.map(m => [facts.elements.find(e => e.expressId === m.elementId)?.type, m.openings.length])).toEqual([['IfcSlab',1],['IfcWall',2]]);
    expect(plan.report.skipped.map(s => [s.name, s.detail.split(': ').slice(1).join(': ')])).toEqual([
      ['door','Structural Face: opening must lie strictly inside boundary'],
      ['oblique','opening extrusion is oblique to the plate normal (more than 1 degree)'],
      ['recess','opening does not span the plate thickness (not through)'],
      ['overlap','Structural Face: openings must not overlap or touch'],
      ['unreadable','no Body representation'],
    ]);
    expect(plan.report.skipped.every(s => s.type === 'IfcOpeningElement')).toBe(true);
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
