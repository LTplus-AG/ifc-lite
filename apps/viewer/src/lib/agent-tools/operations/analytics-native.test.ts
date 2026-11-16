/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { EntityFlags, IfcTypeEnum } from '@ifc-lite/data';
import type { ListDefinition } from '@ifc-lite/lists';
import type { Lens } from '@ifc-lite/lens';
import { createBimContext } from '@ifc-lite/sdk';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { seedCoincidentWalls } from '@/test/clash-run-fixture';
import { resetFeaturesForTest } from '@/lib/features';
import { createMainViewerToolHost } from '../main-viewer-host';
import type { Operation, OperationContext, OperationExecutionContext } from './contract';
import { operationArtifacts, readArtifact } from './artifacts';
import { analyticsListOperations } from './analytics-lists';
import { analyticsChartOperations } from './analytics-charts';
import { analyticsLensOperations } from './analytics-lens';
import { analyticsMeasurementOperations } from './analytics-measurements';
import { analyticsDocumentOperations } from './analytics-document';
import { analyticsCostScheduleOperations } from './analytics-cost-schedule';
import { analyticsDrawingAppearanceOperations } from './analytics-drawing-appearance';
import { analyticsScheduleEditOperations } from './analytics-schedule-edit';
import { analyticsAppearanceOperations } from './analytics-appearance';
import { blankDocument } from '@/lib/document/presets';
import { modelOverviewDashboard } from '@/lib/charts/presets';
import { listRunDefinition, listRunModels } from '@/lib/lists/run-provenance';

const entries = [...analyticsListOperations, ...analyticsChartOperations, ...analyticsLensOperations, ...analyticsMeasurementOperations, ...analyticsDocumentOperations, ...analyticsCostScheduleOperations, ...analyticsDrawingAppearanceOperations, ...analyticsScheduleEditOperations, ...analyticsAppearanceOperations];
let context: OperationContext;
async function seed(count: 1 | 2 = 1) {
  resetFeaturesForTest(); await seedCoincidentWalls(count, 4);
  // This native fixture supplies actual unit-box meshes separately from STEP.
  // Charts consume the loader's HAS_GEOMETRY mark, so mirror that load boundary.
  for (const model of useViewerStore.getState().models.values()) {
    const entities = model.ifcDataStore?.entities;
    if (entities) for (let i = 0; i < entities.count; i++) entities.flags[i] |= EntityFlags.HAS_GEOMETRY;
  }
  useViewerStore.setState({ mutationVersion: 0, selectedEntityId: null, selectedEntityIds: new Set(),
    activeMeasurement: null, activePolyline: null, activeAngle: null, activeRadius: null,
    angleMeasurements: [], radiusMeasurements: [], hiddenEntities: new Set(), lensAppliedHiddenIds: [], lensHiddenIds: new Set(),
    activeLensId: null, listResult: null, activeListId: null, chartSlice: null, chartSliceSource: null });
  const bim = createBimContext({ backend: new LocalBackend(useViewerStore) });
  const host = createMainViewerToolHost(useViewerStore, bim);
  const model = host.models().find(row => row.id === 'A');
  assert.ok(model?.store);
  const commit = <T,>(write: () => T): T => { context.signal?.throwIfAborted(); context.checkpoint?.(); return write(); };
  context = { model: { ...model, store: model.store }, host, commit,
    commitAsync: async <T,>(write: () => Promise<T>): Promise<T> => { context.signal?.throwIfAborted(); context.checkpoint?.(); return write(); },
    artifacts: operationArtifacts(host, commit), canEdit: () => true };
}
async function run<T>(id: string, input: unknown = {}, activeContext: OperationExecutionContext = context): Promise<T> {
  const entry: Operation | undefined = entries.find(row => row.id === id); assert.ok(entry, id);
  const result = await entry.execute(input, activeContext);
  const json: unknown = JSON.parse(JSON.stringify(result)); entry.validateResult(json); return result as T;
}
const list: ListDefinition = { id: 'walls', name: 'Walls', createdAt: 0, updatedAt: 0, entityTypes: [IfcTypeEnum.IfcWall], groups: [], columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }] };

describe('native analytics operations (#10525 deeper automation)', () => {
  beforeEach(async () => seed());
  it('runs all federation rows through the shared Lists service, paginates only the reply and records exact provenance', async () => {
    await seed(2); useViewerStore.setState({ listDefinitions: [list] });
    const result = await run<{ rows: unknown[]; totalCount: number }>('lists.run', { id: list.id, offset: 1, limit: 2 });
    assert.equal(result.rows.length, 2); assert.equal(result.totalCount, 4);
    const stored = useViewerStore.getState().listResult; assert.ok(stored);
    assert.equal(stored.rows.length, 4); assert.equal(listRunDefinition(stored)?.id, list.id);
    assert.deepEqual(listRunModels(stored)?.models.map(row => row.id), ['A', 'B']);
  });
  it('does not publish rows when native query cancellation is requested', async () => {
    useViewerStore.setState({ listDefinitions: [list] }); const abort = new AbortController(); context.signal = abort.signal;
    const pending = run('lists.run', { id: list.id, offset: 0, limit: 10 }); abort.abort();
    await assert.rejects(pending); assert.equal(useViewerStore.getState().listResult, null);
  });
  it('creates retrievable native CSV bytes, after the full query and writer have completed', async () => {
    useViewerStore.setState({ listDefinitions: [list] });
    const result = await run<{ artifact_id: string; bytes: number; filename: string }>('lists.export', { id: list.id, format: 'csv' });
    assert.ok(result.bytes > 0); assert.equal(result.filename, 'Walls.csv');
    const read = await readArtifact(context.host, result.artifact_id, 0, 65536);
    const csv = Buffer.from(read.data, 'base64').toString('utf8');
    assert.match(csv, /Wall 1/); assert.match(csv, /Wall 4/); assert.equal(read.next_offset, null);
  });
  it('refuses invalid native definitions before replacing the saved list library', async () => {
    useViewerStore.setState({ listDefinitions: [list] });
    await assert.rejects(run('lists.import', { content_json: '{"id":"bad"}' }));
    assert.deepEqual(useViewerStore.getState().listDefinitions, [list]);
  });
  it('applies native Lens rules without any mounted panel and releases only owned hides at 1 and N models', async () => {
    const lens: Lens = { id: 'hide', name: 'Hide walls', rules: [{ id: 'walls', name: 'Walls', enabled: true, action: 'hide', color: '#000000', groups: [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }] }] }] };
    for (const count of [1, 2] as const) {
      await seed(count); useViewerStore.setState({ savedLenses: [lens], hiddenEntities: new Set([1]) });
      await run('lens.apply', { id: 'hide' }); assert.equal(useViewerStore.getState().lensHiddenIds.size, 4);
      await run('lens.clear'); assert.deepEqual(useViewerStore.getState().hiddenEntities, new Set([1]));
    }
  });
  it('uses native chart aggregation with model-qualified IDs and creates actual SVG bytes', async () => {
    await seed(2); const dashboard = modelOverviewDashboard(); useViewerStore.setState({ dashboards: [dashboard] });
    const target = { dashboard_id: dashboard.id, chart_id: dashboard.charts[0].id };
    const result = await run<{ total: number; dataFingerprint: string; categoryOf: [number, number[]][] }>('charts.evaluate', target);
    assert.equal(result.total, 4); assert.deepEqual(result.categoryOf.map(([id]) => id).sort((a, b) => a - b), [1, 2, 101, 102]);
    const artifact = await run<{ artifact_id: string }>('charts.exportSvg', target);
    const read = await readArtifact(context.host, artifact.artifact_id, 0, 65536);
    assert.match(Buffer.from(read.data, 'base64').toString('utf8'), /<svg/);
    await assert.rejects(run('charts.focusBuckets', { ...target, data_fingerprint: 'stale', items: [{ seriesIndex: 0, dataIndex: 0 }] }), /source changed/);
    await run('charts.focusBuckets', { ...target, data_fingerprint: result.dataFingerprint, items: [{ seriesIndex: 0, dataIndex: 0 }] });
    assert.deepEqual(useViewerStore.getState().selectedEntityIds, new Set([1, 2, 101, 102]));
    await run('charts.clearFocus'); assert.equal(useViewerStore.getState().selectedEntityIds.size, 0);
  });
  it('creates a 90 degree angle and unit circular-edge radius using real numerical completion', async () => {
    const angle = await run<{ outcome: { degrees: number } }>('measurements.angle', { points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] });
    assert.equal(angle.outcome.degrees, 90); assert.equal(useViewerStore.getState().activeAngle, null);
    const radius = await run<{ outcome: { radiusM: number } }>('measurements.radius', { points: [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]] });
    assert.ok(Math.abs(radius.outcome.radiusM - 1) < 1e-8); assert.equal(useViewerStore.getState().activeRadius, null);
  });
  it('rejects closed schema extras and refuses native writes after a checkpoint revocation', async () => {
    await assert.rejects(run('measurements.angle', { points: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], publish: true }));
    context.checkpoint = () => { throw new Error('Grant revoked'); };
    await assert.rejects(run('measurements.radius', { points: [[1, 0, 0], [0, 1, 0], [-1, 0, 0]] }), /Grant revoked/);
    assert.equal(useViewerStore.getState().radiusMeasurements.length, 0);
  });
  it('renders and retrieves a native PDF document with no IFC model loaded', async () => {
    const document = blankDocument(); document.blocks = [{ kind: 'text', id: 'body', style: 'body', text: 'No model required' }];
    useViewerStore.setState({ models: new Map(), ifcDataStore: null, activeModelId: null, documents: [document] });
    const { model: _model, ...viewerContext } = context;
    assert.equal(entries.find(entry => entry.id === 'document.export')?.needs, 'viewer');
    const result = await run<{ artifact: { artifact_id: string }; pages: number; warnings: string[] }>('document.export', { id: document.id, format: 'pdf' }, viewerContext);
    assert.ok(result.pages >= 1); assert.deepEqual(result.warnings, []);
    const bytes = await readArtifact(context.host, result.artifact.artifact_id, 0, 100);
    assert.match(Buffer.from(bytes.data, 'base64').toString('utf8'), /^%PDF-/);
    await assert.rejects(run('document.replace', { id: document.id, expected_json: '{}', content_json: JSON.stringify(document) }, viewerContext), /changed since inspection/);
    const library = await run<{ definitions: unknown[] }>('lists.library', {}, viewerContext); assert.ok(Array.isArray(library.definitions));
  });
  it('imports native CSV tasks and edits/undoes real schedule dates through native history while preserving model attribution', async () => {
    useViewerStore.setState({ editEnabled: true, scheduleIsEdited: false, scheduleData: null, scheduleSourceModelId: null });
    await run('schedule.initialize');
    await run('schedule.import', { format: 'csv', text: 'Name,Start,Finish\nFoundation,2026-01-05,2026-01-06\nWalls,2026-01-07,2026-01-08\n' });
    const before = structuredClone(useViewerStore.getState().scheduleData); assert.equal(before?.tasks.length, 2);
    const row = before!.tasks[0];
    await run('schedule.updateTask', { id: row.globalId, expected_name: row.name ?? '', Name: 'Revised foundation', Identification: 'F01', IsMilestone: false });
    assert.equal(useViewerStore.getState().scheduleData?.tasks[0].name, 'Revised foundation');
    assert.equal(useViewerStore.getState().scheduleSourceModelId, 'A');
    await run('schedule.history', { action: 'undo' }); assert.equal(useViewerStore.getState().scheduleData?.tasks[0].name, row.name);
    useViewerStore.setState({ editEnabled: false });
    await assert.rejects(run('schedule.updateTask', { id: row.globalId, expected_name: row.name ?? '', Name: 'Denied', Identification: '', IsMilestone: false }), /Edit mode/);
  });
  it('refuses native appearance previews before touching renderer resources when edit mode is off', async () => {
    useViewerStore.setState({ editEnabled: false });
    await assert.rejects(run('appearance.preview', { source_id: 'missing', express_ids: [1], settings: {
      representationPolicy: 'preserve', kind: 'planar', plane: 'xz', repeatU: 1, repeatV: 1, tileWidth: 1, tileHeight: 1, tileDepth: 1, rotationDegrees: 0, offsetU: 0, offsetV: 0, offsetW: 0, repeatS: true, repeatT: true,
    } }), /Edit mode/);
  });

});
