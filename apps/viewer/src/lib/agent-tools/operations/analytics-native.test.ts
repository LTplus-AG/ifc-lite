/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { clearNativeChartSelection, presentChartIds } from '@/components/viewer/charts/useChart3DLink';
import { applyNativeLensResult, evaluateNativeLens, hasCurrentNativeLensResult } from '@/lib/lens/native-lens';
import { beforeEach, describe, it } from 'node:test';
import { EntityFlags, IfcTypeEnum } from '@ifc-lite/data';
import { DEFAULT_SECTION_CONFIG, type Drawing2D } from '@ifc-lite/drawing-2d';
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
import { analyticsDrawingExportOperations } from './analytics-drawing-export';
import { analyticsChartReportOperations } from './analytics-chart-report';
import { analyticsMeasurementSettingOperations } from './analytics-measurement-settings';
import { analyticsAppearanceSettingOperations } from './analytics-appearance-settings';
import { analyticsDrawingSettingOperations } from './analytics-drawing-settings';
import { analyticsPresentationOperations } from './analytics-presentation';
import { analyticsSchedulePlaybackOperations } from './analytics-schedule-playback';
import { analyticsScheduleGenerateOperations } from './analytics-schedule-generate';
import { analyticsDrawingMarkupOperations } from './analytics-drawing-markup';
import { analyticsDrawingSheetOperations } from './analytics-drawing-sheets';
import { analyticsListControlOperations } from './analytics-list-controls';
import { analyticsLensControlOperations } from './analytics-lens-controls';
import { analyticsScheduleControlOperations } from './analytics-schedule-controls';
import { analyticsDrawingControlOperations } from './analytics-drawing-controls';
import { publishDrawingExportFrame } from '@/lib/drawing/export-view-frame';
import { dxfPlaneDrawingMapper } from '@/hooks/dxfReferencePlane';
import { computeAnimationFrame } from '@/components/viewer/schedule/schedule-animator';
import { measuredDimensionValue } from '@/store/slices/drawing2DDimensions';
import { blankDocument } from '@/lib/document/presets';
import { modelOverviewDashboard } from '@/lib/charts/presets';
import { listRunDefinition, listRunModels } from '@/lib/lists/run-provenance';

const entries = [...analyticsListControlOperations, ...analyticsLensControlOperations, ...analyticsScheduleControlOperations, ...analyticsDrawingControlOperations, ...analyticsListOperations, ...analyticsChartOperations, ...analyticsLensOperations, ...analyticsMeasurementOperations, ...analyticsDocumentOperations, ...analyticsCostScheduleOperations, ...analyticsDrawingAppearanceOperations, ...analyticsScheduleEditOperations, ...analyticsAppearanceOperations, ...analyticsScheduleGenerateOperations, ...analyticsDrawingMarkupOperations, ...analyticsDrawingSheetOperations, ...analyticsSchedulePlaybackOperations, ...analyticsPresentationOperations, ...analyticsDrawingExportOperations, ...analyticsChartReportOperations, ...analyticsMeasurementSettingOperations, ...analyticsAppearanceSettingOperations, ...analyticsDrawingSettingOperations];
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
    activeLensId: null, playbackIsPlaying: false, animationEnabled: false, listResult: null, activeListId: null, chartSlice: null, chartSliceSource: null });
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
    assert.deepEqual(result.rows, stored.rows.slice(1, 3));
    assert.deepEqual(listRunModels(stored)?.models.map(row => row.id), ['A', 'B']);
  });
  it('native group X-ray uses exact federated members, toggles off and never releases a successor visibility owner', async () => {
    await seed(2); const { model: _model, ...viewer } = context;
    const input = { key: 'level-1', members: [{ model_id: 'A', express_id: 1 }, { model_id: 'B', express_id: 1 }], channel: 'ghost' };
    await run('lists.presentMembers', input, viewer);
    assert.deepEqual(useViewerStore.getState().ghostExceptEntities, new Set([1, 101]));
    await run('lists.presentMembers', input, viewer); assert.equal(useViewerStore.getState().ghostExceptEntities, null);
    await run('lists.presentMembers', input, viewer);
    useViewerStore.setState({ ghostExceptEntities: new Set([2]) });
    await run('lists.releaseVisibility', {}, viewer); assert.deepEqual(useViewerStore.getState().ghostExceptEntities, new Set([2]));
  });
  it('native column pencil preserves identity/order/custom labels and refuses a stale concurrent definition', async () => {
    const definition: ListDefinition = { ...list, columns: [{ id: 'rating', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'FireRating', label: 'Specified rating' }, ...list.columns] };
    useViewerStore.setState({ listDefinitions: [definition] });
    const input = { id: definition.id, column_id: 'rating', expected_json: JSON.stringify(definition), source: 'quantity', set_name: 'Qto_WallBaseQuantities', property_name: 'NetVolume' };
    await run('lists.editColumn', input);
    const next = useViewerStore.getState().listDefinitions[0]; assert.deepEqual(next.columns.map(column => column.id), ['rating', 'name']);
    assert.equal(next.columns[0].label, 'Specified rating');
    const result = await run<{ columns: { propertyName: string }[] }>('lists.run', { id: definition.id, offset: 0, limit: 5 });
    assert.equal(result.columns[0].propertyName, 'NetVolume');
    await assert.rejects(run('lists.editColumn', input), /changed since inspection/);
  });
  it('native Lens rule switch with equal membership remains isolated and releases only its current claim', async () => {
    useViewerStore.setState({ activeLensId: 'same', lensRuleEntityIds: new Map([['a', [1, 2]], ['b', [1, 2]]]), lensRuleIsolation: null, isolatedEntities: null });
    await run('lens.ruleMembers', { id: 'a', expected_lens_id: 'same', action: 'isolate' });
    await run('lens.ruleMembers', { id: 'b', expected_lens_id: 'same', action: 'isolate' });
    assert.deepEqual(useViewerStore.getState().isolatedEntities, new Set([1, 2]));
    await run('lens.ruleMembers', { id: 'b', expected_lens_id: 'same', action: 'isolate' }); assert.equal(useViewerStore.getState().isolatedEntities, null);
    await assert.rejects(run('lens.ruleMembers', { id: 'a', expected_lens_id: 'replaced', action: 'select' }), /changed/);
    const data = await run<{ data: { classes: string[] } }>('lens.discover', { properties: true, quantities: true, classifications: true, materials: true });
    assert.ok(data.data.classes.includes('IfcWall'));
  });
  it('native Gantt move is one undoable reorder and full animation settings validate without an IFC model', async () => {
    useViewerStore.setState({ editEnabled: true, scheduleData: null, scheduleSourceModelId: null, scheduleIsEdited: false });
    await run('schedule.initialize'); await run('schedule.import', { format: 'csv', text: 'Name,Start,Finish\nFirst,2026-01-05,2026-01-06\nSecond,2026-01-06,2026-01-07\n' });
    const order = useViewerStore.getState().scheduleData?.tasks.map(row => row.globalId); assert.ok(order);
    const moved = await run<{ order: string[] }>('schedule.moveTask', { id: order[0], new_index: 1, expected_order: order }); assert.deepEqual(moved.order, [order[1], order[0]]);
    await run('schedule.history', { action: 'undo' }); assert.deepEqual(useViewerStore.getState().scheduleData?.tasks.map(row => row.globalId), order);
    const { model: _model, ...viewer } = context; const previous = useViewerStore.getState().animationSettings;
    const input = { expected_json: JSON.stringify(previous), settings: { ...previous, paletteIntensity: 0.75, colorizeByTaskType: true, hideUntaskedProducts: true } };
    await run('schedule.configureAnimation', input, viewer);
    const frame = computeAnimationFrame(useViewerStore.getState().scheduleData, Date.parse('2026-01-05T12:00:00Z'), useViewerStore.getState().animationSettings, undefined, [1, 2]);
    assert.deepEqual(frame.hiddenIds, new Set([1, 2]));
    await assert.rejects(run('schedule.configureAnimation', input, viewer), /changed since inspection/);
    await assert.rejects(run('schedule.configureAnimation', { ...input, expected_json: JSON.stringify(useViewerStore.getState().animationSettings), settings: { ...input.settings, palette: { ...input.settings.palette, COMPLETED: [1, 1, 1, 2] } } }, viewer));
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
      await run('lens.apply', { id: 'hide' });
      const current = useViewerStore.getState();
      assert.equal(current.lensHiddenIds.size, 4);
      assert.ok([...current.lensHiddenIds].every(id => current.hiddenEntities.has(id)));
      await run('lens.clear'); assert.deepEqual(useViewerStore.getState().hiddenEntities, new Set([1]));
    }
  });
  it('#10584 releases prior lens rule isolation on switch and preserves replacement isolation', async () => {
    const first: Lens = { id: 'first', name: 'First', rules: [{ id: 'walls', name: 'Walls', enabled: true, action: 'colorize', color: '#123456', groups: [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }] }] }] };
    const second: Lens = { id: 'second', name: 'Second', rules: [] };
    useViewerStore.setState({ savedLenses: [first, second] });
    for (const replacement of [null, [999]]) {
      await run('lens.apply', { id: first.id });
      await run('lens.ruleMembers', { id: 'walls', expected_lens_id: first.id, action: 'isolate' });
      assert.ok(useViewerStore.getState().lensRuleIsolation);
      if (replacement) useViewerStore.getState().isolateEntities(replacement);
      await run('lens.apply', { id: second.id });
      assert.equal(useViewerStore.getState().activeLensId, second.id);
      assert.equal(useViewerStore.getState().lensRuleIsolation, null);
      assert.deepEqual(useViewerStore.getState().isolatedEntities, replacement ? new Set(replacement) : null);
    }
  });
  it('#10584 a chart can take over the exact same Lens isolation without inheriting its claim', async () => {
    const lens: Lens = { id: 'owned', name: 'Owned', rules: [{ id: 'walls', name: 'Walls', enabled: true, action: 'colorize', color: '#123456', groups: [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }] }] }] };
    useViewerStore.setState({ savedLenses: [lens] });
    await run('lens.apply', { id: lens.id });
    await run('lens.ruleMembers', { id: 'walls', expected_lens_id: lens.id, action: 'isolate' });
    const ids = useViewerStore.getState().isolatedEntities;
    assert.ok(ids?.size);
    presentChartIds([...ids], 'isolate');
    assert.equal(useViewerStore.getState().lensRuleIsolation, null);
    await run('lens.clear');
    assert.deepEqual(useViewerStore.getState().isolatedEntities, ids);
  });

  it('#10584 deleting an active saved Lens clears its ID and output without a mounted hook', async () => {
    const lens: Lens = { id: 'delete-active', name: 'Delete active', rules: [{ id: 'walls', name: 'Walls', enabled: true, action: 'colorize', color: '#123456', groups: [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }] }] }] };
    const key = 'ifc-lite-custom-lenses';
    const previous = localStorage.getItem(key);
    try {
      await run('lens.import', { content_json: JSON.stringify([lens]) });
      await run('lens.apply', { id: lens.id });
      await run('lens.ruleMembers', { id: 'walls', expected_lens_id: lens.id, action: 'isolate' });
      assert.ok(useViewerStore.getState().lensColorMap.size > 0);
      assert.ok(useViewerStore.getState().isolatedEntities?.size);
      await run('lens.delete', { id: lens.id });
      const state = useViewerStore.getState();
      assert.equal(state.activeLensId, null);
      assert.equal(state.lensColorMap.size, 0);
      assert.equal(state.lensRuleIsolation, null);
      assert.equal(state.isolatedEntities, null);
      assert.equal(state.savedLenses.some(row => row.id === lens.id), false);
    } finally {
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
    }
  });

  it('#10584 refuses to publish a list deleted while its query is running', async () => {
    useViewerStore.setState({ listDefinitions: [list] });
    const pending = run('lists.run', { id: list.id, offset: 0, limit: 10 });
    useViewerStore.setState({ listDefinitions: [] });
    await assert.rejects(pending, /List definition changed during evaluation/);
    assert.equal(useViewerStore.getState().listResult, null);
  });

  it('#10584 keeps a cleared lens inactive when its pending evaluation completes', async () => {
    const lens: Lens = { id: 'pending', name: 'Pending', rules: [] };
    for (const initialId of [lens.id, null]) {
      useViewerStore.setState({ savedLenses: [lens], activeLensId: initialId });
      const pending = run('lens.apply', { id: lens.id });
      await run('lens.clear');
      await assert.rejects(pending, /active lens changed during evaluation/);
      assert.equal(useViewerStore.getState().activeLensId, null);
    }
  });

  it('#10584 rejects a Lens result computed before a model tag assignment changed', async () => {
    const lens: Lens = { id: 'tagged', name: 'Tagged', rules: [] };
    const previous = useViewerStore.getState().modelTagAssignments;
    useViewerStore.setState({ savedLenses: [lens], activeLensId: lens.id, modelTagAssignments: new Map([['A', new Set(['tag'])]]) });
    try {
      const pending = evaluateNativeLens(lens);
      useViewerStore.setState({ modelTagAssignments: new Map() });
      assert.equal(applyNativeLensResult(lens, await pending), false);
      assert.equal(hasCurrentNativeLensResult(useViewerStore.getState()), false);
      assert.equal(applyNativeLensResult(lens, await evaluateNativeLens(lens)), true);
      assert.equal(hasCurrentNativeLensResult(useViewerStore.getState()), true);
    } finally {
      useViewerStore.setState({ modelTagAssignments: previous });
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

    // #10584: manual clearing keeps the panel's existing semantics, while
    // bridge cleanup preserves a pick made after chart focus.
    for (const manual of [false, true]) {
      await run('charts.focusBuckets', { ...target, data_fingerprint: result.dataFingerprint, items: [{ seriesIndex: 0, dataIndex: 0 }] });
      useViewerStore.getState().setSelectedEntityIds([102]);
      if (manual) clearNativeChartSelection('all');
      else await run('charts.clearFocus');
      assert.deepEqual([...useViewerStore.getState().selectedEntityIds], manual ? [] : [102]);
      assert.equal(useViewerStore.getState().chartSlice, null);
    }
  });
  it('#10584 rejects chart results when the cross-chart slice or its owner changes during evaluation', async () => {
    const dashboard = modelOverviewDashboard();
    const target = { dashboard_id: dashboard.id, chart_id: dashboard.charts[0].id };
    const slice = new Set([1]);
    useViewerStore.setState({ dashboards: [dashboard] });
    for (const next of [new Set([2]), slice]) {
      useViewerStore.getState().setChartSlice(slice, 'first-chart');
      const pending = run('charts.evaluate', target);
      useViewerStore.getState().setChartSlice(next, next === slice ? 'second-chart' : 'first-chart');
      await assert.rejects(pending, /Chart selection changed during evaluation/);
    }
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

  it('generates a native height-group schedule with exact product assignment and optional work-plan grouping', async () => {
    const input = { settings: { strategy: 'IfcElement', startDate: '2026-01-05T08:00:00', daysPerGroup: 2, lagDays: 0, order: 'bottom-up', skipEmptyGroups: true, linkSequences: true, scheduleName: 'Native', predefinedType: 'CONSTRUCTION', heightTolerance: 3, elementZSubgroup: 'none' }, work_plan_name: 'Programme' };
    const preview = await run<{ groups: number; products: number; extraction: { tasks: unknown[]; workSchedules: { type: string }[] } }>('schedule.generatePreview', input);
    assert.equal(preview.groups, 1); assert.equal(preview.products, 4); assert.equal(preview.extraction.tasks.length, 1);
    assert.equal(preview.extraction.workSchedules.length, 2);
    useViewerStore.setState({ editEnabled: true, scheduleData: null, scheduleSourceModelId: null });
    await run('schedule.generate', { ...input, expected_json: 'null' }); assert.equal(useViewerStore.getState().scheduleSourceModelId, 'A');
    await assert.rejects(run('schedule.generate', { ...input, expected_json: 'null' }), /changed since inspection/);
  });
  it('computes native drawing polygon geometry and one undoable numerical dimension with no IFC loaded', async () => {
    const { model: _model, ...viewerContext } = context;
    useViewerStore.setState({ models: new Map(), ifcDataStore: null, activeModelId: null, polygonArea2DPoints: [], polygonArea2DResults: [], dimension2DPoints: [], dimensions2D: [], dimension2DUndo: [], dimension2DRedo: [] });
    await run('drawing.addPolygon', { points: [[0, 0], [3, 0], [3, 4], [0, 4]] }, viewerContext);
    assert.equal(useViewerStore.getState().polygonArea2DResults[0].area, 12); assert.equal(useViewerStore.getState().polygonArea2DResults[0].perimeter, 14);
    await run('drawing.addPolygon', { points: [[0, 0], [3, 0], [3, 4], [0, 4]] }, viewerContext);
    assert.notEqual(useViewerStore.getState().polygonArea2DResults[0].id, useViewerStore.getState().polygonArea2DResults[1].id);
    const dimension = await run<{ id: string }>('drawing.addDimension', { a: [0, 0], b: [3, 4], offset: 1, orientation: 'aligned', text: '<>' }, viewerContext);
    assert.equal(measuredDimensionValue(useViewerStore.getState().dimensions2D[0]), 5);
    await run('drawing.moveMarkup', { id: dimension.id, kind: 'dimension', position: [10, 10] }, viewerContext);
    assert.equal(measuredDimensionValue(useViewerStore.getState().dimensions2D[0]), 5);
    await run('drawing.dimensionHistory', { action: 'undo' }, viewerContext); assert.deepEqual(useViewerStore.getState().dimensions2D[0].a, { x: 0, y: 0 });
  });

  it('#10584 refuses non-finite schedule seek and stop times before changing playback', async () => {
    useViewerStore.setState({ editEnabled: true, scheduleData: null, scheduleSourceModelId: null, scheduleIsEdited: false });
    await run('schedule.initialize');
    await run('schedule.import', { format: 'csv', text: 'Name,Start,Finish\nBuild,2026-01-05,2026-01-06\n' });
    const { playbackTime, scheduleRange } = useViewerStore.getState();
    assert.ok(scheduleRange);
    for (const time of [NaN, Infinity, -Infinity]) {
      await assert.rejects(run('schedule.configureTimeline', {
        work_schedule_id: '', scale: 'day', time, speed: 1, loop: false, animation: false,
      }), /Invalid schedule.configureTimeline input/);
      await assert.rejects(run('schedule.play', { until: time, max_real_seconds: 0.1 }), /Invalid schedule.play input/);
      assert.equal(useViewerStore.getState().playbackTime, playbackTime);
      assert.equal(useViewerStore.getState().playbackIsPlaying, false);
    }
    useViewerStore.getState().seekSchedule(scheduleRange.start - 2);
    await assert.rejects(run('schedule.play', { until: scheduleRange.start - 1, max_real_seconds: 0.1 }), /within the native schedule range/);
    assert.equal(useViewerStore.getState().playbackTime, scheduleRange.start - 2);
  });

  it('awaits native 4D clock completion without mounting Gantt and releases the host runtime', async () => {
    const previousRequest = globalThis.requestAnimationFrame; const previousCancel = globalThis.cancelAnimationFrame;
    let next = 0; const frames = new Map<number, ReturnType<typeof setTimeout>>();
    globalThis.requestAnimationFrame = callback => { const id = ++next; frames.set(id, setTimeout(() => { frames.delete(id); callback(performance.now()); }, 1)); return id; };
    globalThis.cancelAnimationFrame = id => { const timer = frames.get(id); if (timer) clearTimeout(timer); frames.delete(id); };
    const lifetime = new AbortController(); context.host.lifetimeSignal = lifetime.signal;
    try {
      useViewerStore.setState({ editEnabled: true, scheduleData: null, scheduleSourceModelId: null, scheduleIsEdited: false });
      await run('schedule.initialize');
      await run('schedule.import', { format: 'csv', text: 'Name,Start,Finish\nBuild,2026-01-05,2026-01-06\n' });
      const range = useViewerStore.getState().scheduleRange; assert.ok(range);
      useViewerStore.getState().setPlaybackSpeed(3650);
      useViewerStore.getState().setPlaybackLoop(true);
      const result = await run<{ state: string; time: number }>('schedule.play', { until: range.end, max_real_seconds: 2 });
      assert.equal(result.state, 'succeeded'); assert.ok(result.time >= range.end); assert.equal(useViewerStore.getState().playbackIsPlaying, false);
      assert.equal(useViewerStore.getState().playbackLoop, true);
    } finally { lifetime.abort(); for (const timer of frames.values()) clearTimeout(timer); globalThis.requestAnimationFrame = previousRequest; globalThis.cancelAnimationFrame = previousCancel; }
  });
  it('native Presentation Stop cancels an in-flight saved-view sequence and retains the view already applied', async () => {
    const s = useViewerStore.getState(); s.setBasket([{ modelId: 'A', expressId: 1 }]);
    const id = useViewerStore.getState().saveCurrentBasketView({ name: 'Native playback', transitionMs: 150, source: 'manual' }); assert.ok(id);
    const pending = run<{ state: string; played: number }>('presentation.play', { view_ids: [id], repetitions: 2 });
    await new Promise(resolve => setTimeout(resolve, 10));
    await run('presentation.stop'); const result = await pending;
    assert.equal(result.state, 'cancelled'); assert.equal(result.played, 1); assert.equal(useViewerStore.getState().activeBasketViewId, id);
  });

  it('exports real composed SVG/DXF/raw PDF and native sheet SVG without mounting a Drawing panel', async () => {
    const drawing: Drawing2D = { config: { ...DEFAULT_SECTION_CONFIG, plane: { axis: 'y', position: 0, flipped: false }, scale: 100 },
      lines: [{ line: { start: { x: 0, y: 0 }, end: { x: 4, y: 0 } }, category: 'projection', visibility: 'visible', entityId: 1, ifcType: 'IfcWall', modelIndex: 0, depth: 0 }],
      cutPolygons: [], projectionPolygons: [], bounds: { min: { x: 0, y: -1 }, max: { x: 4, y: 2 } },
      stats: { cutLineCount: 0, projectionLineCount: 1, hiddenLineCount: 0, silhouetteLineCount: 0, polygonCount: 0, totalTriangles: 0, processingTimeMs: 0 } };
    const plane = { axis: 'down' as const, position: 50, flipped: false };
    useViewerStore.setState({ drawing2D: drawing, drawing2DStatus: 'ready', drawing2DPlane: plane, sheetEnabled: false, activeSheet: null,
      dxfUnderlays: [], appearanceReferences: new Map(), textAnnotations2D: [], cloudAnnotations2D: [], polygonArea2DResults: [], measure2DResults: [],
      dimensions2D: [{ id: 'on-cut', a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: 0.5, orientation: 'aligned', plane }],
      drawing2DDisplayOptions: { ...useViewerStore.getState().drawing2DDisplayOptions, showScanSection: false } });
    const { model: _model, ...viewerContext } = context;
    const text = await run<{ id: string }>('drawing.addText', { position: [1, 1], text: 'Native typography', font_size: 12, color: '#000000', background: '#ffffff', border: '#000000' }, viewerContext);
    const original = useViewerStore.getState().textAnnotations2D.find(row => row.id === text.id);
    await run('drawing.styleText', { id: text.id, expected_json: JSON.stringify(original), font_size: 24, color: '#123456', background: '#ffffff', border: '#654321' }, viewerContext);
    const imported = await run<{ id: string }>('drawing.importDxf', { filename: 'reference.dxf', units: 'm', register_to_drawing_plane: true,
      content: '0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n10\n20\n20\n11\n12\n21\n22\n0\nENDSEC\n0\nEOF\n' }, viewerContext);
    // #10587: panel placement metadata must preserve the composed export bounds.
    const exportSvg = async () => {
      const result = await run<{ artifact: { artifact_id: string } }>('drawing.export', { format: 'svg', use_display_scale: false, scale: 100 }, viewerContext);
      const read = await readArtifact(context.host, result.artifact.artifact_id, 0, 65536);
      return Buffer.from(read.data, 'base64').toString('utf8');
    };
    const withoutFrame = await exportSvg();
    const cachedSheetTransformRef = { current: null };
    publishDrawingExportFrame({ drawing, isPinned: false, cachedSheetTransformRef });
    try {
      assert.equal((await exportSvg()).match(/viewBox="[^"]+"/)?.[0], withoutFrame.match(/viewBox="[^"]+"/)?.[0]);
    } finally {
      publishDrawingExportFrame({ drawing: null, isPinned: false, cachedSheetTransformRef });
    }
    await run('drawing.centerDxf', { id: imported.id }, viewerContext);
    const underlay = useViewerStore.getState().dxfUnderlays.find(row => row.id === imported.id); assert.ok(underlay?.referenceFrame);
    const mapped = dxfPlaneDrawingMapper(underlay, useViewerStore.getState(), drawing.config.plane); assert.ok(mapped);
    const center = mapped({ x: 11, y: 21 }); assert.ok(Math.abs(center.x - 2) < 1e-8); assert.ok(Math.abs(center.y - 0.5) < 1e-8, 'Center uses the generated model drawing bounds, including its vertical extents');
    for (const format of ['svg', 'dxf', 'pdf'] as const) {
      const result = await run<{ artifact: { artifact_id: string; bytes: number } }>('drawing.export', { format, use_display_scale: false, scale: 100 }, viewerContext);
      assert.ok(result.artifact.bytes > 100);
      const read = await readArtifact(context.host, result.artifact.artifact_id, 0, 65536); const bytes = Buffer.from(read.data, 'base64');
      if (format === 'svg') { assert.match(bytes.toString('utf8'), /<svg/); assert.match(bytes.toString('utf8'), /4000/); assert.match(bytes.toString('utf8'), /Native typography/); assert.match(bytes.toString('utf8'), /#123456/); }
      if (format === 'dxf') { assert.match(bytes.toString('latin1'), /SECTION/); assert.match(bytes.toString('latin1'), /4000/); }
      if (format === 'pdf') assert.match(bytes.toString('latin1'), /^%PDF-/);
    }
    useViewerStore.getState().createSheet(); useViewerStore.getState().updateTitleBlockField('project-name', 'Native composed sheet');
    const sheet = await run<{ artifact: { artifact_id: string } }>('drawing.export', { format: 'svg', use_display_scale: true, scale: 100 }, viewerContext);
    const read = await readArtifact(context.host, sheet.artifact.artifact_id, 0, 65536); assert.match(Buffer.from(read.data, 'base64').toString('utf8'), /Native composed sheet/);
  });
  it('creates a genuine native report PDF with explicit page/title-block controls and no IFC loaded', async () => {
    const dashboard = { ...modelOverviewDashboard(), charts: [], layout: [] };
    useViewerStore.setState({ models: new Map(), ifcDataStore: null, activeModelId: null, dashboards: [dashboard] });
    const { model: _model, ...viewerContext } = context;
    const report = await run<{ artifact: { artifact_id: string }; charts: number; pages: number }>('charts.exportReport', { id: dashboard.id, expected_json: JSON.stringify(dashboard), page: { size: 'A4', orientation: 'landscape' }, title_block: { project: 'Native report witness', title: 'Empty report', author: '', date: '2026-11-16', revision: '' }, snapshots: false, save_setup: false }, viewerContext);
    assert.equal(report.charts, 0); assert.ok(report.pages > 0); const read = await readArtifact(context.host, report.artifact.artifact_id, 0, 65536); assert.match(Buffer.from(read.data, 'base64').toString('latin1'), /^%PDF-/);
  });
  it('completes edge and face angle families and exposes finite native inclination readouts', async () => {
    const edges = await run<{ outcome: { outcome: { degrees: number } } }>('measurements.angleEdges', { points: [[0, 0, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]] });
    assert.equal(edges.outcome.outcome.degrees, 90);
    const priorAngles = useViewerStore.getState().angleMeasurements.length;
    const faces = await run<{ outcome: { outcome: { degrees: number } } }>('measurements.angleFaces', { points: [[0, 0, 0], [1, 0, 0]], normals: [[1, 0, 0], [0, 1, 0]] }); assert.equal(faces.outcome.outcome.degrees, 90);
    assert.equal(useViewerStore.getState().angleMeasurements.length, priorAngles + 1);
    const s = useViewerStore.getState(); s.startMeasurement({ x: 0, y: 0, z: 0, screenX: 0, screenY: 0 }); s.updateMeasurement({ x: 0, y: 5, z: 0, screenX: 0, screenY: 0 }); s.finalizeMeasurement();
    const readouts = await run<{ distances: { inclination: { percent: number | null; percent_unbounded: boolean }; formatted: string }[] }>('measurements.readouts');
    const vertical = readouts.distances.at(-1); assert.equal(vertical?.inclination.percent, null); assert.equal(vertical?.inclination.percent_unbounded, true); assert.match(vertical?.formatted ?? '', /vertical/i);
  });

});
