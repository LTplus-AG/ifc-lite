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
import { IfcParser, extractScheduleOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { createClashEngine, type ClashElement } from '@ifc-lite/clash';
import { addViewpointToTopic, createBCFProject, createBCFTopic, createViewpoint, readBCF, writeBCF } from '@ifc-lite/bcf';
import { aggregate, validateDashboardSpec } from '@ifc-lite/charts';
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

  it('ids and compare: rows carry the renderer id of the entity the result names', () => {
    useViewerStore.setState({
      idsValidationReport: {
        document: { info: { title: 't' }, specifications: [] },
        modelInfo: { modelId: 'mini.ifc', schema: 'IFC4' },
        timestamp: new Date(0),
        summary: { totalSpecifications: 1, totalEntitiesChecked: 2, totalEntitiesPassed: 1, totalEntitiesFailed: 1, overallPassRate: 0.5 },
        specificationResults: [{
          specification: { id: 's1', name: 'Walls have FireRating', applicability: [], requirements: [] },
          status: 'fail', applicableCount: 2, passedCount: 1, failedCount: 1, passRate: 0.5,
          entityResults: [
            { expressId: 41, modelId: 'legacy', entityType: 'IfcWall', passed: true, requirementResults: [] },
            { expressId: 42, modelId: 'legacy', entityType: 'IfcBeam', passed: false, requirementResults: [{ requirement: { type: 'property', instructions: '' }, status: 'fail', facetType: 'property', checkedDescription: '' }] },
          ],
        }],
      } as unknown as NonNullable<ReturnType<typeof useViewerStore.getState>['idsValidationReport']>,
    });
    const ids = buildIdsDataset(useViewerStore.getState());
    const icol = (id: string) => ids.columns.findIndex((c) => c.id === id);
    assert.deepEqual(ids.rows.map((r) => [Array.from(r.ids)[0], r.values[icol(IDS_COLUMNS.result)], r.values[icol(IDS_COLUMNS.failedFacet)]]), [[GID(41), 'pass', ''], [GID(42), 'fail', 'property']]);
    assert.equal(ids.rows[0].values[icol(IDS_COLUMNS.model)], 'mini.ifc');

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
});
