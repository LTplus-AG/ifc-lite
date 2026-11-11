/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #9668: derive an analytical model from a physical one, write it, and read it
// back through a real STEP round trip, in IFC2X3, IFC4 and IFC4X3.
// Set STRUCTURAL_DERIVE_OUT=<dir> to keep the written files (ifcopenshell validation).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { IfcParser, extractPropertiesOnDemand, extractStructuralOnDemand, structuralCounterparts, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { addColumnToStore, applyStructuralDerivation, planStructuralDerivation, readStructuralDerivationFacts, resolveSpatialAnchor } from '../index.js';

type Schema = 'IFC2X3' | 'IFC4' | 'IFC4X3';

/** A millimetre model: two columns, one on a footing; a beam with an Axis
 * representation; a beam typed as not load-bearing; a slab with no LoadBearing. */
function model(schema: Schema): string {
  const tail = (type: string) => (schema === 'IFC2X3' && (type === 'IFCCOLUMN' || type === 'IFCBEAM') ? '' : ',.NOTDEFINED.');
  const lines: string[] = [];
  const random = seeded(11);
  const guid = () => generateIfcGuid(random);
  let id = 1000;
  const add = (text: string) => { lines.push(`#${++id}=${text};`); return id; };
  const pt = (p: number[]) => add(`IFCCARTESIANPOINT((${p.map((v) => v.toFixed(1)).join(',')}))`);
  const dir = (d: number[]) => add(`IFCDIRECTION((${d.map((v) => v.toFixed(1)).join(',')}))`);
  const place = (origin: number[], axis?: number[], ref?: number[]) =>
    add(`IFCAXIS2PLACEMENT3D(#${pt(origin)},${axis ? `#${dir(axis)}` : '$'},${ref ? `#${dir(ref)}` : '$'})`);
  const element = (type: string, name: string, origin: number[], x: number, y: number, depth: number,
    solid: { axis?: number[]; ref?: number[] } = {}, axisLine?: number[][]) => {
    const placement = add(`IFCLOCALPLACEMENT(#20,#${place(origin)})`);
    const profile = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${add(`IFCAXIS2PLACEMENT2D(#${pt([0, 0])},$)`)},${x.toFixed(1)},${y.toFixed(1)})`);
    const body = add(`IFCSHAPEREPRESENTATION(#7,'Body','SweptSolid',(#${add(`IFCEXTRUDEDAREASOLID(#${profile},#${place([0, 0, 0], solid.axis, solid.ref)},#${dir([0, 0, 1])},${depth.toFixed(1)})`)}))`);
    const reps = [body];
    if (axisLine) reps.unshift(add(`IFCSHAPEREPRESENTATION(#7,'Axis','Curve3D',(#${add(`IFCPOLYLINE((${axisLine.map((p) => `#${pt(p)}`).join(',')}))`)}))`));
    const shape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${reps.map((r) => `#${r}`).join(',')}))`);
    const footing = type === 'IFCFOOTING' ? ',.PAD_FOOTING.' : '';
    return add(`${type}('${guid()}',#4,'${name}',$,$,#${placement},#${shape},$${footing || tail(type)})`);
  };
  const pset = (name: string, value: '.T.' | '.F.') =>
    add(`IFCPROPERTYSET('${guid()}',#4,'${name}',$,(#${add(`IFCPROPERTYSINGLEVALUE('LoadBearing',$,IFCBOOLEAN(${value}),$)`)}))`);

  const column1 = element('IFCCOLUMN', 'C1', [0, 0, 0], 300, 300, 3000);
  const column2 = element('IFCCOLUMN', 'C2', [6000, 0, 0], 300, 300, 3000);
  // Body centred 150 mm below the axis; the Axis representation sits on the column tops.
  const beam = element('IFCBEAM', 'B1', [0, 0, 2850], 200, 300, 6000, { axis: [1, 0, 0], ref: [0, 1, 0] }, [[0, 0, 150], [6000, 0, 150]]);
  const secondary = element('IFCBEAM', 'B2', [0, 3000, 2850], 200, 300, 6000, { axis: [1, 0, 0], ref: [0, 1, 0] });
  const slab = element('IFCSLAB', 'S1', [3000, 2000, 3000], 8000, 6000, 200);
  const footing = element('IFCFOOTING', 'F1', [0, 0, -500], 1200, 1200, 500);
  for (const [psetId, related] of [[pset('Pset_ColumnCommon', '.T.'), [column1, column2]], [pset('Pset_BeamCommon', '.T.'), [beam]]] as const) {
    add(`IFCRELDEFINESBYPROPERTIES('${guid()}',#4,$,$,(${related.map((r) => `#${r}`).join(',')}),#${psetId})`);
  }
  const typeId = add(`IFCBEAMTYPE('${guid()}',#4,'Secondary',$,$,(#${pset('Pset_BeamCommon', '.F.')}),$,$,$,.BEAM.)`);
  add(`IFCRELDEFINESBYTYPE('${guid()}',#4,$,$,(#${secondary}),#${typeId})`);
  add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid()}',#4,$,$,(#${column1},#${column2},#${beam},#${secondary},#${slab},#${footing}),#30)`);
  const data = lines.join('\n');
  return `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('derive.ifc','',(''),(''),'','','');FILE_SCHEMA(('${schema}'));ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',#4,'P',$,$,$,$,(#7),#9);
#2=IFCPERSON($,'Author',$,$,$,$,$,$);
#3=IFCORGANIZATION($,'Org',$,$,$);
#4=IFCOWNERHISTORY(#10,#11,$,.NOCHANGE.,$,$,$,0);
#10=IFCPERSONANDORGANIZATION(#2,#3,$);
#11=IFCAPPLICATION(#3,'1','Test','Test');
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCAXIS2PLACEMENT3D(#5,$,$);
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#6,$);
#9=IFCUNITASSIGNMENT((#91));
#91=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#20=IFCLOCALPLACEMENT($,#6);
#30=IFCBUILDINGSTOREY('0storey000000000000000',#4,'Level 0',$,$,#20,$,$,.ELEMENT.,0.);
#31=IFCRELAGGREGATES('0aggr00000000000000000',#4,$,$,#1,(#30));
${data}
ENDSEC;
END-ISO-10303-21;`;
}

async function parse(text: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
}
/** A session wired the way the CLI wires one: properties read on demand. */
function session(store: IfcDataStore) {
  const view = new MutablePropertyView(null, 'm');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  return new StoreEditor(store, view);
}
function seeded(seed = 7) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const byName = (store: IfcDataStore, name: string) => {
  for (const [id] of store.entityIndex.byId) if (store.entities.getName(id) === name) return id;
  throw new Error(`no ${name}`);
};

describe.each(['IFC2X3', 'IFC4', 'IFC4X3'] as const)('derive structural analysis model, %s (#9668)', (schema) => {
  it('derives members, nodes and a footing support, every item linked, and survives a STEP round trip', async () => {
    const store = await parse(model(schema));
    const editor = session(store);
    const plan = planStructuralDerivation(readStructuralDerivationFacts(store, editor));
    expect(plan.report.counts).toMatchObject({ curveMembers: 3, surfaceMembers: 1, nodes: 4, supports: 1, guessedSupports: 0, assumedLoadBearing: 1 });
    expect(plan.report.skipped.map((s) => [s.type, s.reason])).toEqual([['IfcBeam', 'not-load-bearing']]);
    // Millimetres in, metres out: the Axis representation puts the beam on the column tops.
    const beamId = byName(store, 'B1');
    const beam = plan.curveMembers.find((m) => m.elementId === beamId)!;
    expect(beam.axisSource).toBe('axis');
    expect(beam.start.map((v) => +v.toFixed(6) + 0)).toEqual([0, 0, 3]);
    expect(beam.end.map((v) => +v.toFixed(6) + 0)).toEqual([6, 0, 3]);
    expect(plan.surfaceMembers[0].thickness).toBeCloseTo(0.2);

    applyStructuralDerivation(editor, store, plan, seeded());
    const { content } = new StepExporter(store, editor.getMutationView()).export({ schema, applyMutations: true });
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
    const out = process.env.STRUCTURAL_DERIVE_OUT;
    if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, `derived-${schema}.ifc`), text); }

    const reread = await parse(text);
    const data = extractStructuralOnDemand(reread);
    expect(data.analysisModels).toHaveLength(1);
    expect(data.analysisModels[0].itemGlobalIds).toHaveLength(8);
    expect(data.members.map((m) => m.type).sort()).toEqual(['IfcStructuralCurveMember', 'IfcStructuralCurveMember', 'IfcStructuralCurveMember', 'IfcStructuralSurfaceMember']);
    expect(data.connections).toHaveLength(4);
    // Every derived item reaches its physical element, and back.
    for (const item of [...data.members, ...data.connections]) expect(structuralCounterparts(data, item.expressId)?.side).toBe('physical');
    const support = data.connections.filter((c) => c.appliedCondition);
    expect(support).toHaveLength(1);
    const footing = byName(reread, 'F1');
    expect(structuralCounterparts(data, footing)?.expressIds).toEqual([support[0].expressId]);
    const column1 = structuralCounterparts(data, byName(reread, 'C1'))!;
    expect(column1.side).toBe('analytical');
    expect(column1.expressIds).toHaveLength(3); // its member and both end nodes
    expect(structuralCounterparts(data, byName(reread, 'B2'))).toBeNull();

    // A second run, on the written file, plans nothing and apply refuses.
    const again = session(reread);
    const second = planStructuralDerivation(readStructuralDerivationFacts(reread, again));
    expect(second.report.counts.curveMembers + second.report.counts.surfaceMembers).toBe(0);
    expect(second.report.skipped.filter((s) => s.reason === 'already-idealised')).toHaveLength(4);
    expect(() => applyStructuralDerivation(again, reread, second)).toThrow(/no members/);
  });
});

describe('derive structural analysis model: session idempotence (#9668)', () => {
  it('sees its own unsaved output: a second plan in the same session is empty, and a stale plan is refused', async () => {
    const store = await parse(model('IFC4'));
    const editor = session(store);
    const plan = planStructuralDerivation(readStructuralDerivationFacts(store, editor));
    const { analysisModelId } = applyStructuralDerivation(editor, store, plan);
    const second = planStructuralDerivation(readStructuralDerivationFacts(store, editor));
    expect(second.report.counts.curveMembers).toBe(0);
    expect(second.derivedModelId).toBe(analysisModelId);
    expect(() => applyStructuralDerivation(editor, store, plan)).toThrow(/already has a derived analysis model/);
  });

  it('refuses a second model when an element was added after the first derivation', async () => {
    const store = await parse(model('IFC4'));
    const editor = session(store);
    applyStructuralDerivation(editor, store, planStructuralDerivation(readStructuralDerivationFacts(store, editor)));
    addColumnToStore(editor, resolveSpatialAnchor(store, 30, editor.getMutationView()), { Position: [12, 0, 0], Width: 0.3, Depth: 0.3, Height: 3 });
    const later = planStructuralDerivation(readStructuralDerivationFacts(store, editor));
    expect(later.report.counts.curveMembers).toBe(1);
    const before = editor.getNewEntities().length;
    expect(() => applyStructuralDerivation(editor, store, later)).toThrow(/already has a derived analysis model/);
    expect(editor.getNewEntities().length).toBe(before);
  });

  it('refuses a plan whose footing was deleted after planning', async () => {
    const store = await parse(model('IFC4'));
    const editor = session(store);
    const plan = planStructuralDerivation(readStructuralDerivationFacts(store, editor));
    editor.removeEntity(byName(store, 'F1'));
    expect(() => applyStructuralDerivation(editor, store, plan)).toThrow(/footing #\d+ no longer exists/);
  });

  it('places a plan of curve members only whose first member has no storey', async () => {
    const store = await parse(model('IFC4'));
    const editor = session(store);
    const plan = planStructuralDerivation(readStructuralDerivationFacts(store, editor));
    const curvesOnly = { ...plan, surfaceMembers: [], curveMembers: plan.curveMembers.map((m, i) => (i === 0 ? { ...m, storeyId: null } : m)) };
    expect(applyStructuralDerivation(editor, store, curvesOnly).analysisModelId).toBeGreaterThan(0);
  });

  it('refuses before writing when the model has no storey', async () => {
    const store = await parse(model('IFC4'));
    const editor = session(store);
    const plan = planStructuralDerivation(readStructuralDerivationFacts(store, editor));
    const orphan = { ...plan, defaultStoreyId: null, curveMembers: plan.curveMembers.map((m) => ({ ...m, storeyId: null })) };
    const before = editor.getNewEntities().length;
    expect(() => applyStructuralDerivation(editor, store, orphan)).toThrow(/no storey/);
    expect(editor.getNewEntities().length).toBe(before);
  });
});

/** Three 6 m beams in metres: an unnamed Body, a union and a difference. Two storeys. */
const SHAPES = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('s.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,(#7),#9);
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCAXIS2PLACEMENT3D(#5,$,$);
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#6,$);
#9=IFCUNITASSIGNMENT((#91));
#91=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCLOCALPLACEMENT($,#6);
#30=IFCBUILDINGSTOREY('0storey000000000000000',$,'Level 0',$,$,#20,$,$,.ELEMENT.,0.);
#31=IFCLOCALPLACEMENT($,#33);
#33=IFCAXIS2PLACEMENT3D(#34,$,$);
#34=IFCCARTESIANPOINT((0.,0.,3.));
#32=IFCBUILDINGSTOREY('0storey100000000000000',$,'Level 1',$,$,#31,$,$,.ELEMENT.,3.);
#35=IFCRELAGGREGATES('0aggr00000000000000000',$,$,$,#1,(#30,#32));
#40=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,0.2,0.3);
#41=IFCDIRECTION((1.,0.,0.));
#42=IFCDIRECTION((0.,1.,0.));
#43=IFCAXIS2PLACEMENT3D(#5,#41,#42);
#44=IFCDIRECTION((0.,0.,1.));
#45=IFCEXTRUDEDAREASOLID(#40,#43,#44,6.);
#46=IFCEXTRUDEDAREASOLID(#40,#43,#44,6.);
#50=IFCSHAPEREPRESENTATION(#7,$,'SweptSolid',(#45));
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#52=IFCBEAM('0beamUnnamed0000000000',$,'Unnamed',$,$,#20,#51,$,$);
#60=IFCBOOLEANRESULT(.UNION.,#45,#46);
#61=IFCSHAPEREPRESENTATION(#7,'Body','CSG',(#60));
#62=IFCPRODUCTDEFINITIONSHAPE($,$,(#61));
#63=IFCBEAM('0beamUnion000000000000',$,'Union',$,$,#20,#62,$,$);
#70=IFCBOOLEANRESULT(.DIFFERENCE.,#45,#46);
#71=IFCSHAPEREPRESENTATION(#7,'Body','CSG',(#70));
#72=IFCPRODUCTDEFINITIONSHAPE($,$,(#71));
#73=IFCBEAM('0beamDifference0000000',$,'Difference',$,$,#20,#72,$,$);
#81=IFCCARTESIANPOINT((0.,0.,0.));
#82=IFCCARTESIANPOINT((10.,0.,0.));
#83=IFCCARTESIANPOINT((5.,0.,0.));
#84=IFCPOLYLINE((#81,#82,#83));
#85=IFCSHAPEREPRESENTATION(#7,'Axis','Curve3D',(#84));
#86=IFCPRODUCTDEFINITIONSHAPE($,$,(#85));
#87=IFCBEAM('0beamBacktrack00000000',$,'Backtracking axis',$,$,#20,#86,$,$);
#90=IFCCARTESIANPOINTLIST2D(((0.,0.),(4.,4.),(4.,0.),(0.,4.)));
#91=IFCINDEXEDPOLYCURVE(#90,(IFCLINEINDEX((1,3,2,4,1))),.F.);
#92=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#91);
#93=IFCEXTRUDEDAREASOLID(#92,#43,#44,0.2);
#94=IFCSHAPEREPRESENTATION(#7,'Body','SweptSolid',(#93));
#95=IFCPRODUCTDEFINITIONSHAPE($,$,(#94));
#96=IFCSLAB('0slabSegments000000000',$,'Indexed segments',$,$,#20,#95,$,.FLOOR.);
#80=IFCRELCONTAINEDINSPATIALSTRUCTURE('0contain00000000000000',$,$,$,(#52,#63,#73,#87,#96),#30);
ENDSEC;
END-ISO-10303-21;`;

describe('derive structural analysis model: reading shapes and containment (#9668)', () => {
  it('reads an unnamed Body and a difference; refuses a union, a backtracking Axis and indexed segments; places a session column on its storey', async () => {
    const store = await parse(SHAPES);
    const editor = session(store);
    const { columnId } = addColumnToStore(editor, resolveSpatialAnchor(store, 32, editor.getMutationView()), { Position: [0, 0, 0], Width: 0.3, Depth: 0.3, Height: 3 });
    const facts = readStructuralDerivationFacts(store, editor);
    const fact = (id: number) => facts.elements.find((e) => e.expressId === id)!;
    expect(fact(52).prism).toBeDefined();
    expect(fact(73).prism).toBeDefined();
    expect(fact(63).shapeIssue).toMatch(/IFCBOOLEANRESULT/);
    // An Axis polyline that turns back past its end is not a straight axis.
    expect(fact(87).axis).toBeUndefined();
    // Explicit IfcLineIndex segments set the outline order; they are refused, not read in point-list order.
    expect(fact(96).shapeIssue).toMatch(/explicit segments/);
    expect(fact(columnId).storeyId).toBe(32);
    expect(facts.defaultStoreyId).toBe(30);
  });
});
