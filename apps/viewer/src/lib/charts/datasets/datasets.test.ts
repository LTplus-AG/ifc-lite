/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The chart source adapters over REAL producers (#3944): a clash run from
 * the clash engine, a BCF project round-tripped through the writer and
 * reader, a schedule extracted by the parser from IfcTask entities in a
 * parsed model, and the starter dashboards checked against the columns the
 * adapters actually emit.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, extractPropertiesOnDemand, extractScheduleOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { clashReviewKey, createClashEngine, type ClashElement } from '@ifc-lite/clash';
import { addViewpointToTopic, createBCFProject, createBCFTopic, createViewpoint, readBCF, writeBCF } from '@ifc-lite/bcf';
import { aggregate, elementFieldColumnId, validateDashboardSpec, type ElementFieldBinding } from '@ifc-lite/charts';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { buildClashDataset, CLASH_COLUMNS } from './clash.js';
import { buildBcfDataset, BCF_COLUMNS } from './bcf.js';
import { buildScheduleDataset, SCHEDULE_COLUMNS } from './schedule.js';
import { buildIdsDataset, IDS_COLUMNS } from './ids.js';
import { buildCompareDataset, COMPARE_COLUMNS } from './compare.js';
import { buildElementsDataset } from './elements.js';
import { DASHBOARD_PRESETS } from '../presets.js';
import { createElementFieldReader } from '../element-field-reader.js';
import { applyChartFilter, resolveChartFilter } from '../source-filter.js';
import { evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models.js';
import { toGlobalIdFromModels } from '@/store/globalId.js';

const MINI_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#2=IFCSITE('0Site000000000000000002',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#3=IFCBUILDING('0Building00000000000003',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#5=IFCBUILDINGSTOREY('0Storey00000000000005',$,'Level 1',$,$,$,$,$,.ELEMENT.,0.);
#11=IFCRELAGGREGATES('0Agg000000000000000011',$,$,$,#1,(#2));
#12=IFCRELAGGREGATES('0Agg000000000000000012',$,$,$,#2,(#3));
#13=IFCRELAGGREGATES('0Agg000000000000000013',$,$,$,#3,(#5));
#20=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCDIRECTION((0.,0.,1.));
#22=IFCDIRECTION((1.,0.,0.));
#23=IFCAXIS2PLACEMENT3D(#20,#21,#22);
#24=IFCLOCALPLACEMENT($,#23);
#25=IFCRECTANGLEPROFILEDEF(.AREA.,$,#23,1.,1.);
#26=IFCEXTRUDEDAREASOLID(#25,#23,#21,1.);
#27=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#26));
#28=IFCPRODUCTDEFINITIONSHAPE($,$,(#27));
#41=IFCWALL('0Wall00000000000000041',$,'Wall A',$,$,#24,#28,$,$);
#42=IFCBEAM('0Beam00000000000000042',$,'Beam B',$,$,#24,#28,$,$);
#43=IFCDOOR('0Door00000000000000043',$,'Door C',$,$,#24,#28,$,$,$,$,$);
#90=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Rel000000000000000090',$,$,$,(#41,#42,#43),#5);
#100=IFCTASKTIME($,$,$,.WORKTIME.,'P5D','2026-09-07T08:00:00','2026-09-11T17:00:00',$,$,$,$,$,$,.T.,$,$,$,$,$,$);
#101=IFCTASK('0Task00000000000000101',$,'Install walls',$,$,$,$,'NotStarted',$,.F.,$,#100,.CONSTRUCTION.);
#102=IFCTASKTIME($,$,$,.WORKTIME.,'P2D','2026-09-14T08:00:00','2026-09-15T17:00:00',$,$,$,$,$,$,.F.,$,$,$,$,$,$);
#103=IFCTASK('0Task00000000000000103',$,'Hang doors',$,$,$,$,'NotStarted',$,.F.,$,#102,.INSTALLATION.);
#110=IFCRELASSIGNSTOPROCESS('0Asg000000000000000110',$,$,$,(#41,#42),$,#101,$);
#111=IFCRELASSIGNSTOPROCESS('0Asg000000000000000111',$,$,$,(#43),$,#103,$);
ENDSEC;
END-ISO-10303-21;
`;

const OFFSET = 1_000_000;
const GID = (id: number) => OFFSET + id;

let store: IfcDataStore;
async function parsed(): Promise<FederatedModel> {
  const bytes = new TextEncoder().encode(MINI_IFC);
  store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return { ...fixtureModel('m1', { idOffset: OFFSET }), name: 'mini.ifc', ifcDataStore: store, maxExpressId: 120 };
}

function box(key: string, ref: number, tag: string, min: [number, number, number], max: [number, number, number]): ClashElement {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return {
    key, ref, model: 'm1', tag,
    bounds: { min, max },
    positions: new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]),
  };
}

describe('chart source adapters over real producers (#3944)', () => {
  beforeEach(async () => {
    const model = await parsed();
    useViewerStore.setState({ models: new Map([[model.id, model]]), activeModelId: model.id, ifcDataStore: null });
  });

  it('clash: one row per engine clash with both renderer ids, type pair, review and the storey resolved through the federation', async () => {
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(
      [box('0Wall00000000000000041', GID(41), 'IfcWall', [0, 0, 0], [1, 1, 1]), box('0Beam00000000000000042', GID(42), 'IfcBeam', [0.5, 0, 0], [1.5, 1, 1])],
      [{ id: 'str', name: 'STR', a: 'IfcWall', b: 'IfcBeam', mode: 'hard' }],
    );
    assert.equal(result.clashes.length, 1);
    useViewerStore.setState({ clashResult: result, clashGroups: null, clashReviews: new Map(), clashRunSeq: 7 });
    const ds = buildClashDataset(useViewerStore.getState());
    assert.equal(ds.rows.length, 1);
    const [row] = ds.rows;
    assert.deepEqual(Array.from(row.ids).sort(), [GID(41), GID(42)]);
    const col = (id: string) => ds.columns.findIndex((c) => c.id === id);
    assert.equal(row.values[col(CLASH_COLUMNS.rule)], 'str');
    assert.equal(row.values[col(CLASH_COLUMNS.typePair)], 'IfcBeam vs IfcWall');
    assert.equal(row.values[col(CLASH_COLUMNS.review)], 'open');
    assert.equal(row.values[col(CLASH_COLUMNS.storey)], 'Level 1');
    assert.equal(row.values[col(CLASH_COLUMNS.modelA)], 'mini.ifc');
    assert.ok((row.values[col(CLASH_COLUMNS.distance)] as number) < 0);
    // A bucket by type pair carries BOTH elements, so a chart click selects the pair.
    const agg = aggregate({ id: 'c', title: 'c', source: 'clash', type: 'bar', dimension: CLASH_COLUMNS.typePair, measure: { agg: 'count' } }, ds);
    assert.deepEqual([...agg.categories[0].ids].sort(), [GID(41), GID(42)]);
  });

  it('bcf: one row per topic round-tripped through the BCF writer/reader, elements resolved from viewpoint GUIDs, closed date from a closed status', async () => {
    const project = createBCFProject({ name: 'P' });
    const open = createBCFTopic({ title: 'Wall clash', author: 'a@x', topicStatus: 'Open', priority: 'High', assignedTo: 'b@x', dueDate: '2020-01-01T00:00:00Z' });
    open.creationDate = '2026-09-01T10:00:00Z';
    addViewpointToTopic(open, createViewpoint({
      camera: { position: { x: 0, y: 0, z: 10 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, fov: 1 },
      selectedGuids: ['0Wall00000000000000041', '0Beam00000000000000042', 'NotLoadedGuid000000000'],
    }));
    const closed = createBCFTopic({ title: 'Done', author: 'a@x', topicStatus: 'Closed' });
    closed.creationDate = '2026-08-20T10:00:00Z';
    closed.modifiedDate = '2026-09-08T10:00:00Z';
    project.topics.set(open.guid, open);
    project.topics.set(closed.guid, closed);
    const blob = await writeBCF(project);
    const reread = await readBCF(new Uint8Array(await blob.arrayBuffer()));
    useViewerStore.setState({ bcfProject: reread });

    const ds = buildBcfDataset(useViewerStore.getState(), Date.UTC(2026, 8, 12));
    assert.equal(ds.rows.length, 2);
    const col = (id: string) => ds.columns.findIndex((c) => c.id === id);
    const openRow = ds.rows.find((r) => r.values[col(BCF_COLUMNS.status)] === 'Open')!;
    assert.deepEqual(Array.from(openRow.ids).sort(), [GID(41), GID(42)], 'the unloaded GUID is skipped, the loaded ones resolve to renderer ids');
    assert.equal(openRow.values[col(BCF_COLUMNS.due)], 'overdue');
    assert.equal(openRow.values[col(BCF_COLUMNS.priority)], 'High');
    assert.equal(openRow.values[col(BCF_COLUMNS.ageDays)], 11);
    assert.equal(openRow.values[col(BCF_COLUMNS.closed)], null);
    const closedRow = ds.rows.find((r) => r.values[col(BCF_COLUMNS.status)] === 'Closed')!;
    assert.equal(closedRow.values[col(BCF_COLUMNS.closed)], '2026-09-08T10:00:00Z');
    assert.deepEqual(Array.from(closedRow.ids), []);
    // The timeline of closures buckets the closed topic into its ISO week.
    const agg = aggregate({ id: 't', title: 't', source: 'bcf', type: 'timeline', dimension: BCF_COLUMNS.closed, measure: { agg: 'count' } }, ds);
    assert.deepEqual(agg.categories.map((c) => [c.label, c.count]), [['2026-W37', 1]]);
    assert.equal(agg.unbucketed, 1);
  });

  it('schedule: one row per extracted IfcTask with its assigned products as renderer ids and the phase at the playback cursor', () => {
    const extraction = extractScheduleOnDemand(store);
    assert.equal(extraction.tasks.length, 2);
    useViewerStore.setState({ scheduleData: extraction, scheduleSourceModelId: 'm1', animationEnabled: true, playbackTime: Date.UTC(2026, 8, 9, 12) });
    const ds = buildScheduleDataset(useViewerStore.getState());
    const col = (id: string) => ds.columns.findIndex((c) => c.id === id);
    const walls = ds.rows.find((r) => r.values[col(SCHEDULE_COLUMNS.task)] === 'Install walls')!;
    assert.deepEqual(Array.from(walls.ids).sort(), [GID(41), GID(42)]);
    assert.equal(walls.values[col(SCHEDULE_COLUMNS.phase)], 'in progress');
    assert.equal(walls.values[col(SCHEDULE_COLUMNS.critical)], true);
    assert.equal(walls.values[col(SCHEDULE_COLUMNS.products)], 2);
    const doors = ds.rows.find((r) => r.values[col(SCHEDULE_COLUMNS.task)] === 'Hang doors')!;
    assert.equal(doors.values[col(SCHEDULE_COLUMNS.phase)], 'not started');
    assert.deepEqual(Array.from(doors.ids), [GID(43)]);
    // With the animation off, the cursor does not apply.
    useViewerStore.setState({ animationEnabled: false });
    const off = buildScheduleDataset(useViewerStore.getState());
    assert.equal(off.rows[0].values[col(SCHEDULE_COLUMNS.phase)], 'scheduled');
    assert.notEqual(off.fingerprint, ds.fingerprint);
  });

  it('elements: converts an explicit property unit into the project display unit (#4833)', async () => {
    const additions = `
#200=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#201=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#202=IFCUNITASSIGNMENT((#200));
#203=IFCPROPERTYSINGLEVALUE('ExplicitLength',$,IFCLENGTHMEASURE(1.),#201);
#204=IFCPROPERTYSET('0Pset00000000000000204',$,'Probe',$,(#203));
#205=IFCRELDEFINESBYPROPERTIES('0Rel00000000000000205',$,$,$,(#41),#204);`;
    const source = MINI_IFC
      .replace("#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);", "#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,#202);")
      .replace('ENDSEC;\nEND-ISO-10303-21;', `${additions}\nENDSEC;\nEND-ISO-10303-21;`);
    const bytes = new TextEncoder().encode(source);
    const unitStore = await new IfcParser().parseColumnar(bytes.buffer);
    const model = { ...fixtureModel('units', { idOffset: OFFSET }), ifcDataStore: unitStore, maxExpressId: 205 };
    useViewerStore.setState({
      models: new Map([[model.id, model]]),
      activeModelId: model.id,
      mutationViews: new Map(),
      mutationVersion: 0,
      unitDisplayOverrides: {},
    });
    const field: ElementFieldBinding = {
      kind: 'property', psetName: 'Probe', propertyName: 'ExplicitLength', valueKind: 'number', dataType: 'IFCLENGTHMEASURE', unit: 'm',
    };
    const dataset = buildElementsDataset({ kind: 'all' }, [field], useViewerStore.getState());
    const column = dataset.columns.findIndex(({ id }) => id === elementFieldColumnId(field));
    const row = dataset.rows.find(({ ids }) => ids[0] === GID(41));
    assert.notEqual(column, -1, JSON.stringify(dataset.columns));
    assert.equal(dataset.columns[column]?.unit, 'mm');
    assert.equal(row?.values[column], 1_000, 'one explicit metre is normalized to project millimetres');
    assert.equal(row?.statuses?.[column], 'value');

    const overlay = new MutablePropertyView(unitStore.properties, 'units');
    overlay.setOnDemandExtractor((id) => extractPropertiesOnDemand(unitStore, id));
    useViewerStore.setState({ mutationViews: new Map([[model.id, overlay]]), mutationVersion: 1 });
    const withOverlay = buildElementsDataset({ kind: 'all' }, [field], useViewerStore.getState());
    const overlayRow = withOverlay.rows.find(({ ids }) => ids[0] === GID(41));
    assert.equal(overlayRow?.values[column], 1_000, 'installing an unchanged overlay preserves the explicit metre unit');
  });

  it('elements: a typed value with neither project nor explicit unit is unsupported, while the column still names its target (#4833)', async () => {
    const additions = `
#203=IFCPROPERTYSINGLEVALUE('UnconfirmedLength',$,IFCLENGTHMEASURE(1.),$);
#204=IFCPROPERTYSET('0Pset00000000000000204',$,'Probe',$,(#203));
#205=IFCRELDEFINESBYPROPERTIES('0Rel00000000000000205',$,$,$,(#41),#204);`;
    const source = MINI_IFC.replace('ENDSEC;\nEND-ISO-10303-21;', `${additions}\nENDSEC;\nEND-ISO-10303-21;`);
    const bytes = new TextEncoder().encode(source);
    const noUnitStore = await new IfcParser().parseColumnar(bytes.buffer);
    const model = { ...fixtureModel('no-units', { idOffset: OFFSET }), ifcDataStore: noUnitStore, maxExpressId: 205 };
    useViewerStore.setState({
      models: new Map([[model.id, model]]), activeModelId: model.id, mutationViews: new Map(), mutationVersion: 0, unitDisplayOverrides: {},
    });
    const field: ElementFieldBinding = {
      kind: 'property', psetName: 'Probe', propertyName: 'UnconfirmedLength', valueKind: 'number', dataType: 'IFCLENGTHMEASURE',
    };
    const dataset = buildElementsDataset({ kind: 'all' }, [field], useViewerStore.getState());
    const column = dataset.columns.findIndex(({ id }) => id === elementFieldColumnId(field));
    const row = dataset.rows.find(({ ids }) => ids[0] === GID(41));
    assert.equal(dataset.columns[column]?.unit, 'm', 'the column has one target so explicit-unit rows of another model could still sum into it');
    assert.equal(row?.values[column], null, 'a value whose own unit is unknown is never read as metres');
    assert.equal(row?.statuses?.[column], 'unsupported');
  });

  it('elements: normalizes numeric attributes, requires their own project unit, and isolates binding identities (#4833)', async () => {
    const modelSource = (prefix: string, height: number) => MINI_IFC
      .replace("#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);", "#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,#202);")
      .replace("#43=IFCDOOR('0Door00000000000000043',$,'Door C',$,$,#24,#28,$,$,$,$,$);", `#43=IFCDOOR('0Door00000000000000043',$,'Door C',$,$,#24,#28,$,${height},900.,.DOOR.,.SINGLE_SWING_LEFT.,$);`)
      .replace('ENDSEC;\nEND-ISO-10303-21;', `#200=IFCSIUNIT(*,.LENGTHUNIT.,${prefix},.METRE.);\n#202=IFCUNITASSIGNMENT((#200));\nENDSEC;\nEND-ISO-10303-21;`);
    const mmStore = await new IfcParser().parseColumnar(new TextEncoder().encode(modelSource('.MILLI.', 2_000)).buffer);
    const metreStore = await new IfcParser().parseColumnar(new TextEncoder().encode(modelSource('$', 2)).buffer);
    const discovered = createElementFieldReader(mmStore).discover([43]).attributes.find(({ binding }) => binding.kind === 'attribute' && binding.attributeName === 'OverallHeight');
    assert.equal(discovered?.binding.dataType, 'IFCPOSITIVELENGTHMEASURE');
    const field = discovered!.binding;
    const mm = { ...fixtureModel('mm', { idOffset: 0 }), ifcDataStore: mmStore, maxExpressId: 202 };
    const metre = { ...fixtureModel('metre', { idOffset: OFFSET }), ifcDataStore: metreStore, maxExpressId: 202 };
    useViewerStore.setState({ models: new Map([[mm.id, mm], [metre.id, metre]]), activeModelId: mm.id, mutationViews: new Map(), mutationVersion: 0, unitDisplayOverrides: {} });
    const dataset = buildElementsDataset({ kind: 'all' }, [field], useViewerStore.getState());
    const column = dataset.columns.findIndex(({ id }) => id === elementFieldColumnId(field));
    assert.deepEqual(dataset.rows.filter(({ ids }) => ids[0] === 43 || ids[0] === GID(43)).map(({ values }) => values[column]), [2_000, 2_000]);

    const numeric: ElementFieldBinding = { kind: 'property', psetName: 'Probe', propertyName: 'ExplicitLength', valueKind: 'number', dataType: 'IFCLENGTHMEASURE', unit: 'm' };
    const category: ElementFieldBinding = { kind: 'property', psetName: 'Probe', propertyName: 'ExplicitLength', valueKind: 'category' };
    const explicitSource = modelSource('.MILLI.', 2_000).replace('ENDSEC;\nEND-ISO-10303-21;', "#201=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n#203=IFCPROPERTYSINGLEVALUE('ExplicitLength',$,IFCLENGTHMEASURE(1.),#201);\n#204=IFCPROPERTYSET('0Pset00000000000000204',$,'Probe',$,(#203));\n#205=IFCRELDEFINESBYPROPERTIES('0Rel00000000000000205',$,$,$,(#41),#204);\nENDSEC;\nEND-ISO-10303-21;");
    const explicitStore = await new IfcParser().parseColumnar(new TextEncoder().encode(explicitSource).buffer);
    const explicitModel = { ...fixtureModel('explicit', { idOffset: OFFSET }), ifcDataStore: explicitStore, maxExpressId: 205 };
    useViewerStore.setState({ models: new Map([[explicitModel.id, explicitModel]]), activeModelId: explicitModel.id });
    const both = buildElementsDataset({ kind: 'all' }, [category, numeric], useViewerStore.getState());
    const numericColumn = both.columns.findIndex(({ id }) => id === elementFieldColumnId(numeric));
    assert.equal(both.rows.find(({ ids }) => ids[0] === GID(41))?.values[numericColumn], 1_000);
  });

  it('elements: unrelated declared units do not validate an implicit length (#4833)', async () => {
    const additions = `
#201=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#202=IFCUNITASSIGNMENT((#201));
#203=IFCPROPERTYSINGLEVALUE('UnconfirmedLength',$,IFCLENGTHMEASURE(1.),$);
#204=IFCPROPERTYSET('0Pset00000000000000204',$,'Probe',$,(#203));
#205=IFCRELDEFINESBYPROPERTIES('0Rel00000000000000205',$,$,$,(#41),#204);`;
    const source = MINI_IFC
      .replace("#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);", "#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,#202);")
      .replace('ENDSEC;\nEND-ISO-10303-21;', `${additions}\nENDSEC;\nEND-ISO-10303-21;`);
    const unitStore = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer);
    const model = { ...fixtureModel('area-only', { idOffset: OFFSET }), ifcDataStore: unitStore, maxExpressId: 205 };
    useViewerStore.setState({ models: new Map([[model.id, model]]), activeModelId: model.id, mutationViews: new Map(), mutationVersion: 0, unitDisplayOverrides: {} });
    const field: ElementFieldBinding = { kind: 'property', psetName: 'Probe', propertyName: 'UnconfirmedLength', valueKind: 'number', dataType: 'IFCLENGTHMEASURE' };
    const dataset = buildElementsDataset({ kind: 'all' }, [field], useViewerStore.getState());
    const column = dataset.columns.findIndex(({ id }) => id === elementFieldColumnId(field));
    const row = dataset.rows.find(({ ids }) => ids[0] === GID(41));
    assert.equal(dataset.columns[column].unit, 'm');
    assert.equal(row?.values[column], null);
    assert.equal(row?.statuses?.[column], 'unsupported');
  });

  it('elements: rejects incompatible measures and unit-qualifies categorical values (#4833)', async () => {
    const modelSource = (prefix: string, nominal: string) => MINI_IFC
      .replace("#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);", "#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,#202);")
      .replace('ENDSEC;\nEND-ISO-10303-21;', `#200=IFCSIUNIT(*,.LENGTHUNIT.,${prefix},.METRE.);
#202=IFCUNITASSIGNMENT((#200));
#203=IFCPROPERTYSINGLEVALUE('Value',$,${nominal},$);
#204=IFCPROPERTYSET('0Pset00000000000000204',$,'Probe',$,(#203));
#205=IFCRELDEFINESBYPROPERTIES('0Rel00000000000000205',$,$,$,(#41),#204);
ENDSEC;
END-ISO-10303-21;`);
    const parsedModel = async (id: string, offset: number, prefix: string, nominal: string) => ({
      ...fixtureModel(id, { idOffset: offset }),
      ifcDataStore: await new IfcParser().parseColumnar(new TextEncoder().encode(modelSource(prefix, nominal)).buffer),
      maxExpressId: 205,
    });
    const mm = await parsedModel('mm', 0, '.MILLI.', 'IFCLENGTHMEASURE(1.)');
    const metre = await parsedModel('metre', OFFSET, '$', 'IFCLENGTHMEASURE(1.)');
    const ratio = await parsedModel('ratio', OFFSET, '$', 'IFCRATIOMEASURE(2.)');
    const category: ElementFieldBinding = { kind: 'property', psetName: 'Probe', propertyName: 'Value', valueKind: 'category' };
    useViewerStore.setState({ models: new Map([[mm.id, mm], [metre.id, metre]]), activeModelId: mm.id, mutationViews: new Map(), mutationVersion: 0, unitDisplayOverrides: {} });
    const categories = buildElementsDataset({ kind: 'all' }, [category], useViewerStore.getState());
    const categoryColumn = categories.columns.findIndex(({ id }) => id === elementFieldColumnId(category));
    assert.deepEqual(categories.rows.filter(({ ids }) => ids[0] === 41 || ids[0] === GID(41)).map(({ values }) => values[categoryColumn]), ['1 mm', '1 m']);

    const numeric: ElementFieldBinding = { ...category, valueKind: 'number', dataType: 'IFCLENGTHMEASURE' };
    useViewerStore.setState({ models: new Map([[mm.id, mm], [ratio.id, ratio]]), activeModelId: mm.id });
    const numbers = buildElementsDataset({ kind: 'all' }, [numeric], useViewerStore.getState());
    const numberColumn = numbers.columns.findIndex(({ id }) => id === elementFieldColumnId(numeric));
    const ratioRow = numbers.rows.find(({ ids }) => ids[0] === GID(41));
    assert.equal(ratioRow?.values[numberColumn], null);
    assert.equal(ratioRow?.statuses?.[numberColumn], 'unsupported');
  });

  /** A model whose project declares one unit list and carries one `Probe.Cost` / `Probe.Value` property on the wall. */
  const unitModel = async (id: string, offset: number, units: string, property: string, extra = '') => {
    const source = MINI_IFC
      .replace("#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);", "#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,#202);")
      .replace('ENDSEC;\nEND-ISO-10303-21;', `${units}
#202=IFCUNITASSIGNMENT((#200));
${property}
${extra}
#204=IFCPROPERTYSET('0Pset00000000000000204',$,'Probe',$,(#203));
#205=IFCRELDEFINESBYPROPERTIES('0Rel00000000000000205',$,$,$,(#41),#204);
ENDSEC;
END-ISO-10303-21;`);
    return {
      ...fixtureModel(id, { idOffset: offset }),
      ifcDataStore: await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer),
      maxExpressId: 210,
    };
  };
  const cellOf = (dataset: ReturnType<typeof buildElementsDataset>, field: ElementFieldBinding, id: number) => {
    const column = dataset.columns.findIndex((c) => c.id === elementFieldColumnId(field));
    const row = dataset.rows.find(({ ids }) => ids[0] === id);
    return { unit: dataset.columns[column]?.unit, value: row?.values[column], status: row?.statuses?.[column] };
  };

  it('elements: never sums two currencies — a monetary column is one currency, other currencies read unsupported (#4833)', async () => {
    const cost = "#203=IFCPROPERTYSINGLEVALUE('Cost',$,IFCMONETARYMEASURE(10.),$);";
    const usd = await unitModel('usd', 0, "#200=IFCMONETARYUNIT('USD');", cost);
    const eur = await unitModel('eur', OFFSET, "#200=IFCMONETARYUNIT('EUR');", cost);
    const usd2 = await unitModel('usd2', 2 * OFFSET, "#200=IFCMONETARYUNIT('USD');", cost);
    const field: ElementFieldBinding = { kind: 'property', psetName: 'Probe', propertyName: 'Cost', valueKind: 'number', dataType: 'IFCMONETARYMEASURE' };
    const discovered = createElementFieldReader(usd.ifcDataStore).discover([41]).properties.get('Probe')?.[0]?.binding;
    assert.deepEqual(discovered, field, 'a monetary property is discovered as a number keyed by its measure');

    useViewerStore.setState({ models: new Map([[usd.id, usd], [eur.id, eur], [usd2.id, usd2]]), activeModelId: usd.id, mutationViews: new Map(), mutationVersion: 0, unitDisplayOverrides: {} });
    const dataset = buildElementsDataset({ kind: 'all' }, [field], useViewerStore.getState());
    assert.deepEqual(cellOf(dataset, field, 41), { unit: '$', value: 10, status: 'value' });
    assert.deepEqual(cellOf(dataset, field, 2 * OFFSET + 41), { unit: '$', value: 10, status: 'value' }, 'the same currency in another model sums');
    assert.deepEqual(cellOf(dataset, field, GID(41)), { unit: '$', value: null, status: 'unsupported' }, 'there is no exchange rate to fold euros into dollars');
    const agg = aggregate({ id: 'c', title: 'c', source: 'elements', type: 'bar', dimension: 'Model', measure: { agg: 'sum', column: elementFieldColumnId(field) } }, dataset);
    assert.equal(agg.total, 20);
    assert.equal(agg.unsupported, 1);
    assert.equal(agg.unit, '$');
  });

  it('elements: an explicit unit is converted by its own scale, and an unresolvable one is never read as the project unit (#4833)', async () => {
    const mmProject = "#200=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);";
    // A decimetre is a real SI unit the viewer has no curated alternative for: only its parsed scale can convert it.
    const dm = await unitModel('dm', 0, mmProject, "#203=IFCPROPERTYSINGLEVALUE('Length',$,IFCLENGTHMEASURE(1.),#206);", '#206=IFCSIUNIT(*,.LENGTHUNIT.,.DECI.,.METRE.);');
    // `#999` names no entity: the file declares a unit we cannot read.
    const broken = await unitModel('broken', OFFSET, mmProject, "#203=IFCPROPERTYSINGLEVALUE('Length',$,IFCLENGTHMEASURE(1.),#999);");
    const field: ElementFieldBinding = { kind: 'property', psetName: 'Probe', propertyName: 'Length', valueKind: 'number', dataType: 'IFCLENGTHMEASURE' };
    useViewerStore.setState({ models: new Map([[dm.id, dm], [broken.id, broken]]), activeModelId: dm.id, mutationViews: new Map(), mutationVersion: 0, unitDisplayOverrides: {} });
    const dataset = buildElementsDataset({ kind: 'all' }, [field], useViewerStore.getState());
    const decimetre = cellOf(dataset, field, 41);
    assert.equal(decimetre.unit, 'mm');
    assert.ok(typeof decimetre.value === 'number' && Math.abs(decimetre.value - 100) < 1e-9, `1 dm is 100 mm, got ${String(decimetre.value)}`);
    assert.deepEqual(cellOf(dataset, field, GID(41)), { unit: 'mm', value: null, status: 'unsupported' }, 'an unreadable explicit unit must not fall back to the project millimetres');
    assert.equal(createElementFieldReader(broken.ifcDataStore).readResolved(41, field).unit, '#999');
  });

  it('elements: an untagged number never joins a typed sum, and an untyped number keeps only a unit equal to the column\'s (#4833 review)', async () => {
    const mmProject = "#200=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);";
    // `1000.` with no IFC measure tag: nothing says it is a length.
    const bare = await unitModel('bare', 0, mmProject, "#203=IFCPROPERTYSINGLEVALUE('Length',$,1000.,$);");
    const length: ElementFieldBinding = { kind: 'property', psetName: 'Probe', propertyName: 'Length', valueKind: 'number', dataType: 'IFCLENGTHMEASURE' };
    useViewerStore.setState({ models: new Map([[bare.id, bare]]), activeModelId: bare.id, mutationViews: new Map(), mutationVersion: 0, unitDisplayOverrides: {} });
    assert.deepEqual(cellOf(buildElementsDataset({ kind: 'all' }, [length], useViewerStore.getState()), length, 41), { unit: 'mm', value: null, status: 'unsupported' });
    // An IfcReal in millimetres under a binding discovered without a measure cannot be converted into anything.
    const realMm = await unitModel('real', OFFSET, mmProject, "#203=IFCPROPERTYSINGLEVALUE('Ratio',$,IFCREAL(2.),#206);", '#206=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);');
    const ratio: ElementFieldBinding = { kind: 'property', psetName: 'Probe', propertyName: 'Ratio', valueKind: 'number', dataType: 'IFCREAL' };
    useViewerStore.setState({ models: new Map([[realMm.id, realMm]]), activeModelId: realMm.id });
    assert.equal(cellOf(buildElementsDataset({ kind: 'all' }, [ratio], useViewerStore.getState()), ratio, GID(41)).status, 'unsupported');
  });

  it('elements: a quantity sums in one unit across a millimetre and a metre model, and honours its own explicit Unit (#4833)', async () => {
    const qtoModel = async (id: string, offset: number, prefix: string, depth: string, unitRef = '$', extra = '') => {
      const source = MINI_IFC
        .replace("#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);", "#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,#202);")
        .replace('ENDSEC;\nEND-ISO-10303-21;', `#200=IFCSIUNIT(*,.LENGTHUNIT.,${prefix},.METRE.);
#202=IFCUNITASSIGNMENT((#200));
${extra}
#203=IFCQUANTITYLENGTH('Depth',$,${unitRef},${depth},$);
#204=IFCELEMENTQUANTITY('0Qto000000000000000204',$,'Qto_WallBaseQuantities',$,'BaseQuantities',(#203));
#205=IFCRELDEFINESBYPROPERTIES('0Rel00000000000000205',$,$,$,(#41),#204);
ENDSEC;
END-ISO-10303-21;`);
      return { ...fixtureModel(id, { idOffset: offset }), ifcDataStore: await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer), maxExpressId: 210 };
    };
    const mm = await qtoModel('mm', 0, '.MILLI.', '250.');
    const metre = await qtoModel('metre', OFFSET, '$', '0.25');
    // A metre-project quantity that declares its own centimetre unit.
    const explicit = await qtoModel('explicit', 2 * OFFSET, '$', '25.', '#206', '#206=IFCSIUNIT(*,.LENGTHUNIT.,.CENTI.,.METRE.);');
    const field: ElementFieldBinding = { kind: 'quantity', qsetName: 'Qto_WallBaseQuantities', quantityName: 'Depth', valueKind: 'number', dataType: 'IFCLENGTHMEASURE' };
    assert.deepEqual(createElementFieldReader(mm.ifcDataStore).discover([41]).quantities.get('Qto_WallBaseQuantities')?.[0]?.binding, field);
    useViewerStore.setState({ models: new Map([[mm.id, mm], [metre.id, metre], [explicit.id, explicit]]), activeModelId: mm.id, mutationViews: new Map(), mutationVersion: 0, unitDisplayOverrides: {} });
    const dataset = buildElementsDataset({ kind: 'all' }, [field], useViewerStore.getState());
    const near = (cell: { value: unknown }, expected: number) => typeof cell.value === 'number' && Math.abs(cell.value - expected) < 1e-9;
    assert.equal(cellOf(dataset, field, 41).unit, 'mm');
    assert.ok(near(cellOf(dataset, field, 41), 250));
    assert.ok(near(cellOf(dataset, field, GID(41)), 250), `0.25 m is 250 mm, got ${String(cellOf(dataset, field, GID(41)).value)}`);
    assert.ok(near(cellOf(dataset, field, 2 * OFFSET + 41), 250), `25 cm is 250 mm, got ${String(cellOf(dataset, field, 2 * OFFSET + 41).value)}`);
    const agg = aggregate({ id: 'q', title: 'q', source: 'elements', type: 'bar', dimension: 'Model', measure: { agg: 'sum', column: elementFieldColumnId(field) } }, dataset);
    assert.ok(Math.abs(agg.total - 750) < 1e-9);
    assert.equal(agg.unit, 'mm');
  });

  it('elements: one quantity name observed as a Length in one model and an Area in another is a category, not a mis-typed sum (#4833 review)', async () => {
    const qsetOf = (klass: string, value: string) => `#200=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#202=IFCUNITASSIGNMENT((#200));
#203=${klass}('Size',$,$,${value},$);
#204=IFCELEMENTQUANTITY('0Qto000000000000000204',$,'Qto_Probe',$,$,(#203));
#205=IFCRELDEFINESBYPROPERTIES('0Rel00000000000000205',$,$,$,(#41),#204);
ENDSEC;
END-ISO-10303-21;`;
    const parsedQto = async (id: string, offset: number, klass: string, value: string) => ({
      ...fixtureModel(id, { idOffset: offset }),
      ifcDataStore: await new IfcParser().parseColumnar(new TextEncoder().encode(MINI_IFC
        .replace("#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);", "#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,#202);")
        .replace('ENDSEC;\nEND-ISO-10303-21;', qsetOf(klass, value))).buffer),
      maxExpressId: 205,
    });
    const asLength = await parsedQto('len', 0, 'IFCQUANTITYLENGTH', '2.');
    const asArea = await parsedQto('area', OFFSET, 'IFCQUANTITYAREA', '3.');
    const { mergeObservations, catalogFromObservations, emptyObservations } = await import('../element-field-discovery.js');
    const merged = emptyObservations();
    mergeObservations(merged, createElementFieldReader(asLength.ifcDataStore).observe([41]));
    mergeObservations(merged, createElementFieldReader(asArea.ifcDataStore).observe([41]));
    const size = catalogFromObservations(merged).quantities.get('Qto_Probe')?.[0]?.binding;
    assert.equal(size?.kind, 'quantity');
    assert.equal(size?.valueKind, 'category', 'a length and an area cannot share one sum');
    useViewerStore.setState({ models: new Map([[asLength.id, asLength], [asArea.id, asArea]]), activeModelId: asLength.id, mutationViews: new Map(), mutationVersion: 0, unitDisplayOverrides: {} });
    const dataset = buildElementsDataset({ kind: 'all' }, [size!], useViewerStore.getState());
    assert.deepEqual([cellOf(dataset, size!, 41).value, cellOf(dataset, size!, GID(41)).value], ['2 m', '3 m²'], 'both rows chart as unit-qualified categories');
  });

  it('clash: the fingerprint follows a regroup and a review status edit, so a selected Other bucket cannot stay live on moved rows (#4833)', async () => {
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(
      [
        box('0Wall00000000000000041', GID(41), 'IfcWall', [0, 0, 0], [1, 1, 1]),
        box('0Beam00000000000000042', GID(42), 'IfcBeam', [0.5, 0, 0], [1.5, 1, 1]),
        box('0Door00000000000000043', GID(43), 'IfcDoor', [0.8, 0, 0], [1.8, 1, 1]),
      ],
      [{ id: 'str', name: 'STR', a: 'IfcWall', b: 'IfcBeam', mode: 'hard' }, { id: 'arc', name: 'ARC', a: 'IfcWall', b: 'IfcDoor', mode: 'hard' }],
    );
    assert.equal(result.clashes.length, 2);
    const [first, second] = result.clashes;
    const group = (title: string, members: typeof result.clashes) => ({
      id: title, title, members, bounds: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] }, representativePoint: [0, 0, 0] as [number, number, number], severity: first.severity,
    });
    const state = (groups: ReturnType<typeof group>[], review: 'open' | 'accepted') => {
      useViewerStore.setState({ clashResult: result, clashRunSeq: 3, clashGroups: groups, clashReviews: new Map([[clashReviewKey(first), { status: review }]]) });
      return buildClashDataset(useViewerStore.getState());
    };
    const together = state([group('G1', [first, second])], 'open');
    const apart = state([group('G1', [first]), group('G2', [second])], 'open');
    assert.notEqual(apart.fingerprint, together.fingerprint, 'moving a clash between groups changes which bucket it is in');
    assert.equal(apart.rows.length, together.rows.length);
    const accepted = state([group('G1', [first]), group('G2', [second])], 'accepted');
    assert.notEqual(accepted.fingerprint, apart.fingerprint, 'a status edit keeps the review count but moves the row');
    assert.equal(state([group('G1', [first]), group('G2', [second])], 'accepted').fingerprint, accepted.fingerprint, 'the same state fingerprints the same');
  });

  it('ids and compare: rows carry the renderer id of the entity the result names', () => {
    useViewerStore.setState({
      idsValidationReport: {
        source: { kind: 'ids', document: { info: { title: 't' }, specifications: [] } },
        modelInfo: [{ modelId: 'mini.ifc', schema: 'IFC4' }],
        timestamp: new Date(0),
        summary: { totalSpecifications: 1, totalEntitiesChecked: 2, totalEntitiesPassed: 1, totalEntitiesFailed: 1, overallPassRate: 0.5 },
        specificationResults: [{
          specification: { id: 's1', name: 'Walls have FireRating', applicability: [], requirements: [] },
          status: 'fail', applicableCount: 2, passedCount: 1, failedCount: 1, passRate: 0.5,
          entityResults: [
            { expressId: 41, modelId: 'legacy', entityType: 'IfcWall', passed: true, requirementResults: [] },
            { expressId: 42, modelId: 'legacy', entityType: 'IfcBeam', passed: false, requirementResults: [{ requirement: { type: 'property', instructions: '', label: 'FireRating is set' }, status: 'fail', facetType: 'property', checkedDescription: '', failureReason: 'FireRating is not set' }] },
          ],
        }],
      } as unknown as NonNullable<ReturnType<typeof useViewerStore.getState>['idsValidationReport']>,
    });
    const ids = buildIdsDataset(useViewerStore.getState());
    const icol = (id: string) => ids.columns.findIndex((c) => c.id === id);
    assert.deepEqual(ids.rows.map((r) => [Array.from(r.ids)[0], r.values[icol(IDS_COLUMNS.result)], r.values[icol(IDS_COLUMNS.failedFacet)]]), [[GID(41), 'pass', ''], [GID(42), 'fail', 'property']]);
    assert.equal(ids.rows[0].values[icol(IDS_COLUMNS.model)], 'mini.ifc');

    // #5138 §7: additive Requirement/Reason/Source columns. The passing
    // entity has no failed requirement, so Requirement/Reason are empty;
    // Source is 'ids' for every row regardless of pass/fail.
    assert.deepEqual(
      ids.rows.map((r) => [r.values[icol(IDS_COLUMNS.requirement)], r.values[icol(IDS_COLUMNS.reason)], r.values[icol(IDS_COLUMNS.source)]]),
      [['', '', 'ids'], ['FireRating is set', 'FireRating is not set', 'ids']],
    );

    useViewerStore.setState({
      compareRunSeq: 3,
      compareResult: {
        baseModelId: 'a', headModelId: 'b', baseName: 'rev-a.ifc', headName: 'rev-b.ifc', scope: 'both', geometryUnavailable: false, excludedGlobalIds: new Set(),
        diff: {
          scope: 'both', excludedTypes: [], byKey: new Map(), counts: { added: 1, modified: 1, deleted: 1, unchanged: 0 },
          entries: [
            { key: 'g1', state: 'added', changeKinds: [], head: { key: 'g1', ifcType: 'IfcWall', dataHash: 'x', ref: { modelId: 'b', localId: 1, globalId: 2_000_001 } } },
            { key: 'g2', state: 'modified', changeKinds: ['data', 'geometry'], base: { key: 'g2', ifcType: 'IfcDoor', dataHash: 'x', ref: { modelId: 'a', localId: 2, globalId: 1_000_002 } }, head: { key: 'g2', ifcType: 'IfcDoor', dataHash: 'y', ref: { modelId: 'b', localId: 2, globalId: 2_000_002 } } },
            { key: 'g3', state: 'deleted', changeKinds: [], base: { key: 'g3', ifcType: 'IfcSlab', dataHash: 'x', ref: { modelId: 'a', localId: 3, globalId: 1_000_003 } } },
          ],
        },
      } as unknown as NonNullable<ReturnType<typeof useViewerStore.getState>['compareResult']>,
    });
    const cmp = buildCompareDataset(useViewerStore.getState());
    const ccol = (id: string) => cmp.columns.findIndex((c) => c.id === id);
    assert.deepEqual(cmp.rows.map((r) => [Array.from(r.ids)[0], r.values[ccol(COMPARE_COLUMNS.state)], r.values[ccol(COMPARE_COLUMNS.change)], r.values[ccol(COMPARE_COLUMNS.side)]]), [
      [2_000_001, 'added', 'added', 'rev-b.ifc'],
      [2_000_002, 'modified', 'data + geometry', 'rev-b.ifc'],
      [1_000_003, 'deleted', 'deleted', 'rev-a.ifc'],
    ]);
  });

  it('every starter dashboard validates and every chart names a column its source emits', () => {
    const state = useViewerStore.getState();
    const columns = {
      elements: buildElementsDataset({ kind: 'all' }, state).columns,
      clash: buildClashDataset(state).columns,
      bcf: buildBcfDataset(state).columns,
      schedule: buildScheduleDataset(state).columns,
      ids: buildIdsDataset(state).columns,
      compare: buildCompareDataset(state).columns,
    };
    for (const preset of DASHBOARD_PRESETS) {
      const dashboard = preset.create();
      assert.deepEqual(validateDashboardSpec(dashboard), [], preset.name);
      for (const chart of dashboard.charts) {
        const cols = columns[chart.source];
        assert.ok(cols.some((c) => c.id === chart.dimension), `${preset.name}/${chart.title}: dimension ${chart.dimension}`);
        if (chart.stackBy) assert.ok(cols.some((c) => c.id === chart.stackBy), `${preset.name}/${chart.title}: stackBy ${chart.stackBy}`);
        if (chart.measure.column) assert.ok(cols.some((c) => c.id === chart.measure.column && c.kind === 'number'), `${preset.name}/${chart.title}: measure`);
        const dim = cols.find((c) => c.id === chart.dimension)!;
        if (chart.type === 'timeline') assert.equal(dim.kind, 'date', chart.title);
        if (chart.type === 'histogram') assert.equal(dim.kind, 'number', chart.title);
      }
    }
  });

  // #4946 — a chart's own source filter: the SAME matching path the search
  // Filter tab uses (`readSelector` -> `evaluateFilterRulesFederated`), then
  // ONE post-filter (`applyChartFilter`) shared by every source.
  it('source filter: resolveChartFilter + applyChartFilter narrow an elements row set, and keep a clash row on an any-match', async () => {
    const state = useViewerStore.getState();
    const models = evaluatorModelsFromState(state);
    const toGlobalId = (modelId: string, expressId: number) => toGlobalIdFromModels(state.models, modelId, expressId);

    const ids = await resolveChartFilter(models, { selector: 'IfcWall' }, toGlobalId, { limit: 1_000 });
    assert.ok(ids);
    assert.deepEqual([...(ids as Set<number>)], [GID(41)], 'IfcWall matches only the one wall in the fixture');

    const elementsDs = buildElementsDataset({ kind: 'all' }, state);
    assert.equal(elementsDs.rows.length, 3, 'unfiltered: wall + beam + door');
    const filteredElements = applyChartFilter(elementsDs, ids as Set<number>);
    assert.equal(filteredElements.rows.length, 1, 'filtered: the wall row only');
    assert.notEqual(filteredElements.fingerprint, elementsDs.fingerprint, 'a filtered dataset never reuses the unfiltered fingerprint');

    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(
      [box('0Wall00000000000000041', GID(41), 'IfcWall', [0, 0, 0], [1, 1, 1]), box('0Beam00000000000000042', GID(42), 'IfcBeam', [0.5, 0, 0], [1.5, 1, 1])],
      [{ id: 'str', name: 'STR', a: 'IfcWall', b: 'IfcBeam', mode: 'hard' }],
    );
    useViewerStore.setState({ clashResult: result, clashGroups: null, clashReviews: new Map(), clashRunSeq: 8 });
    const clashDs = buildClashDataset(useViewerStore.getState());
    assert.equal(clashDs.rows.length, 1);
    const filteredClash = applyChartFilter(clashDs, ids as Set<number>);
    assert.equal(filteredClash.rows.length, 1, 'the clash keeps its row: ids [wall, beam] any-matches the filtered wall');
  });

  it('source filter: a refused reading (no rule, unsupported syntax, or a parse error) THROWS instead of narrowing on the readable part', async () => {
    const state = useViewerStore.getState();
    const models = evaluatorModelsFromState(state);
    const toGlobalId = (modelId: string, expressId: number) => toGlobalIdFromModels(state.models, modelId, expressId);

    // No filterable class/attribute at all — reads as plain text, zero rules.
    await assert.rejects(() => resolveChartFilter(models, { selector: 'NotARealIfcClass' }, toGlobalId));
    // A parse error (unterminated regex).
    await assert.rejects(() => resolveChartFilter(models, { selector: 'Name=/unterminated' }, toGlobalId));
    // A rule exists (the property clause) but the class+GlobalId combination
    // in the same group is unsupported (#4904/#4987 — a class and a GlobalId
    // both ADD elements rather than narrow, so an AND cannot express it) —
    // still refused rather than run on the readable property rule alone.
    await assert.rejects(() => resolveChartFilter(models, { selector: 'IfcWall, 0MoO$xC5PB9uNyzGgqhL9B, Probe.Tag=Special' }, toGlobalId));

    // No filter at all resolves to `null`, never an error.
    assert.equal(await resolveChartFilter(models, undefined, toGlobalId), null);
    assert.equal(await resolveChartFilter(models, { selector: '   ' }, toGlobalId), null);
  });

  // #4904/#4987 landed on main while this PR was open: a `+`-separated
  // selector is now a real OR-of-AND-groups query, not a refusal. Route the
  // chart filter through the same groups-aware evaluator
  // (`evaluateFilterGroupsFederated`) so a chart's own filter supports `+`
  // exactly as the search Filter tab does — never a second matching path.
  it('source filter: a "+" union resolves as the OR of both groups (#4904/#4987 groups-aware evaluator)', async () => {
    const state = useViewerStore.getState();
    const models = evaluatorModelsFromState(state);
    const toGlobalId = (modelId: string, expressId: number) => toGlobalIdFromModels(state.models, modelId, expressId);
    const ids = await resolveChartFilter(models, { selector: 'IfcWall + IfcDoor' }, toGlobalId, { limit: 1_000 });
    assert.deepEqual([...(ids as Set<number>)].sort((a, b) => a - b), [GID(41), GID(43)], 'the wall and the door — the union of both groups, not just the first');

    const mixedIds = await resolveChartFilter(
      models,
      { selector: 'IfcWall, Name="Beam B" + IfcDoor, Name="Door C"' },
      toGlobalId,
      { limit: 1_000 },
    );
    assert.deepEqual([...(mixedIds as Set<number>)], [GID(43)], 'each union branch keeps its own AND terms');
  });

  // #4946 review (PR #4984): a chart filter used to match only the ON-DISK
  // property value — `evaluatorModelsFromState` never carried a model's
  // live `MutablePropertyView` into the evaluator (`filter-evaluate.ts`'s
  // `psetsFor`/`qtysFor`/`attrsFor` read the base store only). Editing a
  // property a selector rule reads must change what the rule matches in the
  // SAME session, without a reload — same live-edit awareness
  // `element-field-reader.ts` already gives the Elements chart's own field
  // column, now shared by the filter evaluator every chart source (and
  // search, and clash set filters) runs its selector through.
  it('source filter: editing a property changes what the selector matches — filtered count drops (mutation-aware evaluator, review finding)', async () => {
    const before = useViewerStore.getState();
    const beforeModels = evaluatorModelsFromState(before);
    const toGlobalId = (modelId: string, expressId: number) => toGlobalIdFromModels(before.models, modelId, expressId);
    const selector = 'Probe.Tag="Special"';
    const beforeIds = await resolveChartFilter(beforeModels, { selector }, toGlobalId, { limit: 1_000 });
    assert.deepEqual([...(beforeIds as Set<number>)], [], 'nothing has the property yet — no rows in the base file');

    const overlay = new MutablePropertyView(store.properties, 'm1');
    overlay.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
    overlay.setProperty(41, 'Probe', 'Tag', 'Special');
    useViewerStore.setState({ mutationViews: new Map([['m1', overlay]]), mutationVersion: 1 });

    const after = useViewerStore.getState();
    const afterModels = evaluatorModelsFromState(after);
    const afterIds = await resolveChartFilter(afterModels, { selector }, toGlobalId, { limit: 1_000 });
    assert.deepEqual([...(afterIds as Set<number>)], [GID(41)], 'the wall now matches: the evaluator read the live edit, not the on-disk file');

    // The inverse case the review asked for: edit a matching element so it
    // STOPS matching — the filtered count drops.
    const overlay2 = new MutablePropertyView(store.properties, 'm1');
    overlay2.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
    overlay2.setProperty(41, 'Probe', 'Tag', 'Special');
    overlay2.setProperty(41, 'Probe', 'Tag', 'Different');
    useViewerStore.setState({ mutationViews: new Map([['m1', overlay2]]), mutationVersion: 2 });
    const cleared = useViewerStore.getState();
    const clearedModels = evaluatorModelsFromState(cleared);
    const clearedIds = await resolveChartFilter(clearedModels, { selector }, toGlobalId, { limit: 1_000 });
    assert.deepEqual([...(clearedIds as Set<number>)], [], 'edited away from the matching value: the wall no longer matches, count drops to 0');
  });

  it('applyChartFilter: two different same-size id sets never fingerprint alike (review finding on PR #4984)', () => {
    const state = useViewerStore.getState();
    const dataset = buildElementsDataset({ kind: 'all' }, state);
    const a = applyChartFilter(dataset, new Set([GID(41)]));
    const b = applyChartFilter(dataset, new Set([GID(42)]));
    assert.notEqual(a.fingerprint, b.fingerprint, 'ids.size alone would have collided {wall} and {beam}');
    assert.equal(applyChartFilter(dataset, new Set([GID(41)])).fingerprint, a.fingerprint, 'the same id set fingerprints the same');
  });

  // #5156 — building a chart from ONE clash run/check instead of every rule
  // of the current result being counted together.
  it('applyClashRuleFilter: narrows to one rule\'s rows, composes with applyChartFilter, and leaves an unknown dataset untouched', async () => {
    // Dynamic (not static) import: reverting this slice's production change
    // removes the `applyClashRuleFilter` export from source-filter.ts while
    // `applyChartFilter` / `resolveChartFilter` (imported statically above)
    // still exist on both sides. A static import of `applyClashRuleFilter`
    // would fail the whole test FILE to load (does not provide an export
    // named 'applyClashRuleFilter') instead of letting the assertions below
    // fail on their own merits — see PropertyEditor.i18n.test.tsx for the
    // same pattern used against a whole-module revert.
    const { applyClashRuleFilter } = await import('../source-filter.js');
    const engine = createClashEngine({ backend: 'ts' });
    const result = await engine.run(
      [
        box('0Wall00000000000000041', GID(41), 'IfcWall', [0, 0, 0], [1, 1, 1]),
        box('0Beam00000000000000042', GID(42), 'IfcBeam', [0.5, 0, 0], [1.5, 1, 1]),
        box('0Door00000000000000043', GID(43), 'IfcDoor', [0.8, 0, 0], [1.8, 1, 1]),
      ],
      [{ id: 'str', name: 'STR', a: 'IfcWall', b: 'IfcBeam', mode: 'hard' }, { id: 'arc', name: 'ARC', a: 'IfcWall', b: 'IfcDoor', mode: 'hard' }],
    );
    assert.equal(result.clashes.length, 2, 'two rules, one clash each');
    useViewerStore.setState({ clashResult: result, clashGroups: null, clashReviews: new Map(), clashRunSeq: 9 });
    const ds = buildClashDataset(useViewerStore.getState());
    assert.equal(ds.rows.length, 2, 'unfiltered: both rules counted together — the bug #5156 reports');

    const strOnly = applyClashRuleFilter(ds, 'str');
    assert.equal(strOnly.rows.length, 1, 'narrowed to the STR rule alone');
    assert.deepEqual(Array.from(strOnly.rows[0].ids).sort(), [GID(41), GID(42)]);
    assert.notEqual(strOnly.fingerprint, ds.fingerprint, 'a rule-filtered dataset never reuses the unfiltered fingerprint');

    const arcOnly = applyClashRuleFilter(ds, 'arc');
    assert.equal(arcOnly.rows.length, 1, 'narrowed to the ARC rule alone');
    assert.deepEqual(Array.from(arcOnly.rows[0].ids).sort(), [GID(41), GID(43)]);
    assert.notEqual(arcOnly.fingerprint, strOnly.fingerprint, 'different rules fingerprint differently');

    const unknownRule = applyClashRuleFilter(ds, 'not-a-real-rule-id');
    assert.equal(unknownRule.rows.length, 0, 'an id naming no rule matches nothing — never falls back to "all"');

    // Composes with the selector filter (#4946): AND, not OR. GID(41) (the
    // wall) is on both rows, so selecting it alone would pass this
    // assertion pair even if `applyChartFilter` were a no-op — the rule
    // filter narrows to 1 row on its own. GID(42) (the beam) is only on the
    // `str` row, so selecting it distinguishes the two: `str` still has a
    // row to narrow, `arc` has none left once the selector has run.
    const beamIds = new Set([GID(42)]);
    const strAndBeam = applyClashRuleFilter(applyChartFilter(ds, beamIds), 'str');
    assert.equal(strAndBeam.rows.length, 1);
    const arcAndBeam = applyClashRuleFilter(applyChartFilter(ds, beamIds), 'arc');
    assert.equal(arcAndBeam.rows.length, 0, 'the beam-only selector removes the arc row before the rule filter ever runs');

    // A source with no `Rule` column (e.g. `elements`) is a silent no-op,
    // not a thrown error — the caller (`validate.ts`) is what stops a
    // `clashRule` from ever reaching a non-clash dataset.
    const elementsDs = buildElementsDataset({ kind: 'all' }, useViewerStore.getState());
    assert.deepEqual(applyClashRuleFilter(elementsDs, 'str'), elementsDs);
  });

  it('validateDashboardSpec: clashRule is only valid on a clash chart, must be non-empty, and a filter needs a selector or a clashRule (#5156)', () => {
    const base = { version: 2 as const, id: 'd', name: 'D', scope: { kind: 'all' as const }, layout: [] };
    const chart = (filter: unknown, source: 'clash' | 'elements' = 'clash') => ({
      id: 'c1', title: 'C', source, type: 'bar', dimension: CLASH_COLUMNS.rule, measure: { agg: 'count' }, filter,
    });

    assert.deepEqual(validateDashboardSpec({ ...base, charts: [chart({ selector: '', clashRule: 'str' })] }), [], 'clashRule alone, no selector text, is valid');
    assert.deepEqual(validateDashboardSpec({ ...base, charts: [chart({ selector: 'IfcWall', clashRule: 'str' })] }), [], 'both together are valid');

    const emptyFilter = validateDashboardSpec({ ...base, charts: [chart({ selector: '' })] });
    assert.equal(emptyFilter.length, 1, 'neither a selector nor a clashRule: rejected, not silently "no filter"');
    assert.match(emptyFilter[0].message, /selector.*clashRule|clashRule.*selector/);

    const emptyClashRule = validateDashboardSpec({ ...base, charts: [chart({ selector: '', clashRule: '' })] });
    assert.ok(emptyClashRule.some((e) => e.path === '.charts[0].filter.clashRule'), 'an empty-string clashRule is rejected outright, never read as "no filter"');

    const wrongSource = validateDashboardSpec({ ...base, charts: [chart({ selector: '', clashRule: 'str' }, 'elements')] });
    assert.ok(wrongSource.some((e) => e.path === '.charts[0].filter.clashRule' && e.message.includes('only valid for the clash source')));
  });

  it('validateDashboardSpec: a whitespace-only selector is rejected even alongside a clashRule (#5176)', () => {
    const base = { version: 2 as const, id: 'd', name: 'D', scope: { kind: 'all' as const }, layout: [] };
    const chart = (filter: unknown, source: 'clash' | 'elements' = 'clash') => ({
      id: 'c1', title: 'C', source, type: 'bar', dimension: CLASH_COLUMNS.rule, measure: { agg: 'count' }, filter,
    });

    // `''` is the editor's unset sentinel: accepted when a real `clashRule`
    // narrows the chart instead.
    assert.deepEqual(validateDashboardSpec({ ...base, charts: [chart({ selector: '', clashRule: 'str' })] }), [], "the editor's empty-string sentinel is accepted alongside clashRule");

    // `'   '` is never the sentinel — a human or an import wrote it — and it
    // trims to "no filter" at every consumer, so it is rejected regardless
    // of `clashRule`.
    const whitespaceWithRule = validateDashboardSpec({ ...base, charts: [chart({ selector: '   ', clashRule: 'str' })] });
    assert.equal(whitespaceWithRule.length, 1, 'a whitespace-only selector is rejected even with a clashRule present');
    assert.equal(whitespaceWithRule[0].path, '.charts[0].filter.selector');

    const whitespaceNoRule = validateDashboardSpec({ ...base, charts: [chart({ selector: '   ' })] });
    assert.equal(whitespaceNoRule.length, 1, 'a whitespace-only selector is rejected with no clashRule too');
    assert.equal(whitespaceNoRule[0].path, '.charts[0].filter.selector');

    assert.deepEqual(validateDashboardSpec({ ...base, charts: [chart({ selector: 'real', clashRule: 'str' })] }), [], 'a real selector alongside clashRule is accepted');
  });
});
