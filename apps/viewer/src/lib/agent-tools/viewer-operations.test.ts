/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import type { Renderer } from '@ifc-lite/renderer';
import { coordinationDashboard } from '@/lib/charts/presets';
import { registerAgentViewportHost } from '@/lib/agent-bridge/viewport-host';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { configuredView } from '@/test/agent-tools-fixture';
import { ClashNamespace, createBimContext } from '@ifc-lite/sdk';
import { summarizeClashes, type ClashResult } from '@ifc-lite/clash';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { seedCoincidentWalls } from '@/test/clash-run-fixture';
import { resetFeaturesForTest } from '@/lib/features';
import { createMainViewerToolHost } from './main-viewer-host';
import { dispatchMainViewerTool, mainViewerTool } from './main-viewer-dispatch';
import { nativeExportRegistryInventory } from './operations/export-native-inventory';
import { EXPORT_COMMAND_IDS } from '@/components/viewer/toolbar/export-commands';
import { WORKSPACE_PANELS } from '@/lib/panels/registry';
import { viewerOperations } from './operations/registry';
import type { ToolHost } from './types';

let host: ToolHost;
async function seed(n: 1 | 2 = 1) {
  resetFeaturesForTest();
  await seedCoincidentWalls(n, 4);
  useViewerStore.setState({ mutationVersion: 0, mutationViews: new Map(), selectedEntityId: null, selectedEntityIds: new Set(),
    measurements: [], polylineMeasurements: [], activeMeasurement: null, activePolyline: null, activeAngle: null, activeRadius: null });
  host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
}
const execute = (id: string, input: unknown = {}, extra: Record<string, unknown> = {}, canEdit = true) =>
  dispatchMainViewerTool(host, 'viewer_operation_execute', { ...(viewerOperations().find(operation => operation.id === id)?.needs === 'model' ? { model_id: 'A' } : {}), operation_id: id, input, ...extra }, { canEdit: () => canEdit });
const inspect = (id: string, input: unknown = {}, extra: Record<string, unknown> = {}) =>
  dispatchMainViewerTool(host, 'viewer_operation_inspect', { ...(viewerOperations().find(operation => operation.id === id)?.needs === 'model' ? { model_id: 'A' } : {}), operation_id: id, input, ...extra });
const job = (job_id: string) => dispatchMainViewerTool(host, 'viewer_operation_job', { job_id });
async function loadCoverageAudit() {
  // Check the coverage tool is registered before importing its module, so a missing tool fails a test instead of the file load.
  assert.ok(mainViewerTool('viewer_operation_coverage'), 'coverage is registered as a viewer tool');
  return import('./operations/coverage');
}
function data<T>(value: { structured: unknown; isError: boolean; text: string }): T { assert.equal(value.isError, false, value.text); return value.structured as T; }
/** Holds `ClashNamespace.run` until its abort signal fires and, unless `released`, until `release()`. */
function holdClashRunner(t: { mock: { method: typeof import('node:test').mock.method } }, { released = false } = {}) {
  let entered!: () => void, aborted!: () => void, release!: () => void;
  const settle = released ? Promise.resolve() : new Promise<void>(r => { release = r; });
  const gate = { entered: new Promise<void>(r => { entered = r; }), aborted: new Promise<void>(r => { aborted = r; }), release: () => release?.() };
  const run = ClashNamespace.prototype.run;
  t.mock.method(ClashNamespace.prototype, 'run', async function (this: ClashNamespace, ...args: Parameters<typeof run>) {
    entered();
    const signal = args[2]?.signal;
    assert.ok(signal, 'clash.analyze must pass its abort signal to the engine');
    if (!signal.aborted) await once(signal, 'abort');
    aborted();
    await settle;
    return run.apply(this, args);
  });
  return gate;
}
async function settled(id: string) {
  for (let i = 0; i < 50; i++) {
    await setImmediate();
    const value = await job(id);
    if (value.isError || (value.structured as { state: string }).state !== 'running') return value;
  }
  throw new Error('Job did not settle after bounded event-loop turns.');
}

describe('parameterized native viewer operations (#10525 follow-up)', () => {
  beforeEach(async () => seed());
  it('discovers bounded pages and exact schemas without running feature actions', async () => {
    const before = useViewerStore.getState();
    const result = await dispatchMainViewerTool(host, 'viewer_operations', { limit: 2 });
    const found = data<{ total: number; operations: unknown[]; next_offset: number }>(result);
    assert.ok(found.total > 40); assert.equal(found.operations.length, 2); assert.equal(found.next_offset, 2);
    assert.equal(useViewerStore.getState(), before);
    const detail = data<{ operations: Array<{ inputSchema: { additionalProperties: boolean }; effects: string[] }> }>(
      await dispatchMainViewerTool(host, 'viewer_operations', { operation_id: 'measurements.distance' }));
    assert.equal(detail.operations[0].inputSchema.additionalProperties, false);
    assert.deepEqual(detail.operations[0].effects, ['view']);
  });
  it('rejects reflective/prototype IDs and closed-schema argument smuggling', async () => {
    for (const id of ['constructor', '__proto__', 'viewer.constructor', 'store.delete']) {
      assert.equal((await execute(id)).isError, true, id);
    }
    assert.equal((await execute('environment.exposure', { value: 1, publish: true })).isError, true);
    assert.equal((await execute('environment.exposure', { value: Infinity })).isError, true);
    assert.equal((await execute('environment.exposure', { value: '1' })).isError, true);
  });
  it('refuses all mutations through inspect and without the current commands grant', async () => {
    const initial = useViewerStore.getState().envExposure;
    assert.equal((await inspect('environment.exposure', { value: 1.8 })).errorCode, 'READ_ONLY');
    assert.equal((await execute('environment.exposure', { value: 1.8 }, {}, false)).errorCode, 'READ_ONLY');
    assert.equal(useViewerStore.getState().envExposure, initial);
  });
  it('rechecks a grant revoked while the lazy executor is loading', async () => {
    let granted = true;
    const pending = dispatchMainViewerTool(host, 'viewer_operation_execute', {
      operation_id: 'environment.exposure', input: { value: 1.7 },
    }, { canEdit: () => granted });
    granted = false;
    assert.equal((await pending).errorCode, 'READ_ONLY');
  });
  it('validates all model-local entity IDs before changing either selection channel', async () => {
    const missing = await execute('selection.replace', { express_ids: [1, 987654] });
    assert.equal(missing.errorCode, 'INVALID_INPUT');
    assert.equal((missing.structured as { reason: string }).reason, 'unknown-target');
    assert.equal(useViewerStore.getState().selectedEntityId, null);
    const applied = await execute('selection.replace', { express_ids: [1, 2] });
    assert.equal(applied.isError, false, applied.text);
    assert.deepEqual(useViewerStore.getState().selectedEntityIds, new Set([1, 2]));
  });
  it('routes a second federated model without interpreting express IDs as renderer IDs', async () => {
    await seed(2);
    const selected = await execute('selection.replace', { express_ids: [1] }, { model_id: 'B' });
    assert.equal(selected.isError, false, selected.text);
    assert.deepEqual(useViewerStore.getState().selectedEntityIds, new Set([101]));
  });
  it('creates numerical distance and perimeter through native measurement completion', async () => {
    const result = data<{ result: { distance: number } }>(await execute('measurements.distance', { start: [0, 0, 0], end: [3, 4, 0] }));
    assert.equal(result.result.distance, 5);
    assert.equal(useViewerStore.getState().measurements.length, 1);
    const perimeter = await execute('measurements.polyline', { points: [[0, 0, 0], [3, 0, 0], [3, 4, 0]], closed: true });
    assert.equal(perimeter.isError, false, perimeter.text);
    assert.equal(useViewerStore.getState().polylineMeasurements.length, 1);
  });
  it('deduplicates measurement retries and refuses key reuse for changed input', async () => {
    const input = { start: [0, 0, 0], end: [3, 4, 0] };
    const first = await execute('measurements.distance', input, { idempotency_key: 'distance-1' });
    const second = await execute('measurements.distance', input, { idempotency_key: 'distance-1' });
    assert.equal(first.isError, false, first.text); assert.deepEqual(second.structured, first.structured);
    assert.equal(useViewerStore.getState().measurements.length, 1);
    assert.equal((await execute('measurements.distance', { ...input, end: [1, 1, 1] }, { idempotency_key: 'distance-1' })).isError, true);
  });
  it('exports a real changed IFC artifact without downloading or discarding pending edits (#10796)', async () => {
    const view = new MutablePropertyView(null, 'A');
    view.setAttribute(1, 'Name', 'AGENT-EXPORTED-WALL');
    useViewerStore.setState({ mutationViews: new Map([['A', view]]), mutationVersion: 1 });
    const result = data<{ committed: boolean; result: { artifact: { artifact_id: string }; files: Array<{ model_id: string }> } }>(await execute('exports.changedModels'));
    assert.equal(result.committed, true);
    assert.equal(result.result.files[0].model_id, 'A');
    const chunk = data<{ data: string; next_offset: number | null }>(await dispatchMainViewerTool(host, 'viewer_artifact_read', { artifact_id: result.result.artifact.artifact_id, offset: 0, length: 65536 }));
    assert.equal(chunk.next_offset, null);
    assert.match(Buffer.from(chunk.data, 'base64').toString('utf8'), /AGENT-EXPORTED-WALL/);
    const pending = useViewerStore.getState().getMutationView('A')?.getAttributeMutationsForEntity(1);
    assert.equal(pending?.find(edit => edit.name === 'Name')?.value, 'AGENT-EXPORTED-WALL');
    const unload = await execute('model.unload');
    assert.equal(unload.isError, true);
    assert.match(unload.text, /unexported changes/);
    assert.ok(useViewerStore.getState().models.has('A'));
  });
  it('reports the actual artifact filename for a long single-model name (#10795 item 82)', async () => {
    const models = new Map(useViewerStore.getState().models);
    models.set('A', { ...models.get('A')!, name: `${'long-name-'.repeat(12)}.ifc` });
    const view = new MutablePropertyView(null, 'A');
    view.setAttribute(1, 'Name', 'Renamed');
    useViewerStore.setState({ models, mutationViews: new Map([['A', view]]), mutationVersion: 1 });
    const { result } = data<{ result: { artifact: { filename: string }; files: Array<{ filename: string }> } }>(await execute('exports.changedModels'));
    assert.equal(result.files[0].filename, result.artifact.filename);
    assert.match(result.artifact.filename, /\.ifc$/);
  });
  it('validates every basket reference before changing native basket isolation', async () => {
    useViewerStore.getState().clearBasket();
    const before = useViewerStore.getState().isolatedEntities;
    assert.equal((await execute('basket.replace', { express_ids: [1, 999999] })).isError, true);
    assert.equal(useViewerStore.getState().pinboardEntities.size, 0);
    assert.equal(useViewerStore.getState().isolatedEntities, before);
    assert.equal((await inspect('basket.clear')).errorCode, 'READ_ONLY');
    assert.equal((await execute('basket.replace', { express_ids: [1] }, {}, false)).errorCode, 'READ_ONLY');
    assert.equal(useViewerStore.getState().pinboardEntities.size, 0);
  });
  it('exports explicit native STEP targets and refuses an unknown merge member before retaining an artifact', async () => {
    const options = { schema: 'IFC4', include_geometry: true, apply_mutations: true, visible_only: false, section_mode: 'trim' };
    const exported = data<{ result: { artifact: { artifact_id: string }; diagnostics_json: string } }>(await execute('exports.modelStep', options));
    const bytes = data<{ data: string }>(await dispatchMainViewerTool(host, 'viewer_artifact_read', { artifact_id: exported.result.artifact.artifact_id }));
    assert.match(Buffer.from(bytes.data, 'base64').toString('utf8'), /IFCWALL/);
    await seed(2);
    const refused = await execute('exports.mergedStep', { ...options, model_ids: ['A', 'missing'], unit_reconciliation: 'assume-shared' });
    assert.equal(refused.isError, true);
    assert.deepEqual(data<{ artifacts: unknown[] }>(await dispatchMainViewerTool(host, 'viewer_artifacts', {})).artifacts, []);
    // The fixture gives both models the same wall names and GlobalIds (the clash tests need that), and the
    // merge de-duplicates by GlobalId. Give B's wall its own identity and mark one wall per model.
    const views = new Map(['A', 'B'].map(id => {
      const store = useViewerStore.getState().models.get(id)!.ifcDataStore!;
      const view = configuredView(store, id);
      view.setAttribute(1, 'Name', `Merged marker ${id}`);
      if (id === 'B') view.setAttribute(1, 'GlobalId', '0001bbbbbbbbbbbbbbbbbb');
      return [id, view] as const;
    }));
    useViewerStore.setState({ mutationViews: views });
    const merged = data<{ result: { artifact: { artifact_id: string }; diagnostics_json: string } }>(await execute('exports.mergedStep', { ...options, model_ids: ['A', 'B'], unit_reconciliation: 'assume-shared' }));
    const diagnostics = JSON.parse(merged.result.diagnostics_json) as { stats: { modelCount: number }; skipped: unknown[] };
    assert.equal(diagnostics.stats.modelCount, 2); assert.deepEqual(diagnostics.skipped, []);
    const mergedText = Buffer.from(data<{ data: string }>(await dispatchMainViewerTool(host, 'viewer_artifact_read', { artifact_id: merged.result.artifact.artifact_id })).data, 'base64').toString('utf8');
    for (const id of ['A', 'B']) assert.equal(mergedText.split(`Merged marker ${id}`).length - 1, 1, id);
  });
  it('evaluates a native BCF dashboard before any IFC model is loaded', async () => {
    useViewerStore.setState({ models: new Map(), ifcDataStore: null, bcfProject: null });
    assert.equal((await execute('bcf.createProject', { value: 'Native coordination' })).isError, false);
    for (const status of ['Open', 'Closed']) assert.equal((await execute('bcf.createTopic', { title: status, description: '', status })).isError, false);
    const dashboard = coordinationDashboard();
    assert.equal(useViewerStore.getState().upsertDashboard(dashboard), true);
    const chart = dashboard.charts.find(row => row.source === 'bcf'); assert.ok(chart);
    const result = data<{ result: { total: number; categories: unknown[] } }>(await inspect('charts.evaluate', { dashboard_id: dashboard.id, chart_id: chart.id }));
    assert.equal(result.result.total, 2); assert.equal(result.result.categories.length, 2);
  });
  it('runs native Rules filters, rejects stale configuration, and pages the published result', async () => {
    const state = data<{ result: { native_json: string } }>(await inspect('filters.state'));
    const initial = JSON.parse(state.result.native_json) as { configuration_json: string };
    const next = JSON.stringify({ filter: { groups: [{ combinator: 'AND', rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }] }], limit: 100 }, query: '' });
    const changed = data<{ result: { native_json: string } }>(await execute('filters.configure', { expected_json: initial.configuration_json, configuration_json: next }));
    const configured = JSON.parse(changed.result.native_json) as { configuration_json: string };
    assert.equal((await execute('filters.run', { expected_json: initial.configuration_json })).isError, true);
    const result = await execute('filters.run', { expected_json: configured.configuration_json });
    assert.equal(result.isError, false, result.text);
    assert.equal(useViewerStore.getState().searchFilterResult?.rows.length, 4);
    const first = data<{ result: { native_json: string } }>(await inspect('filters.results', { offset: 0, limit: 1 }));
    const { next_offset: offset, page_revision } = JSON.parse(first.result.native_json) as { next_offset: number; page_revision: string };
    assert.equal(offset, 1); assert.ok(page_revision);
    const page = data<{ result: { native_json: string } }>(await inspect('filters.results', { offset, page_revision, limit: 2 }));
    const rows = JSON.parse(page.result.native_json) as { total: number; rows: unknown[][]; current: boolean };
    assert.equal(rows.total, 4); assert.equal(rows.rows.length, 2); assert.equal(rows.current, true);
    useViewerStore.setState({ mutationVersion: 1 });
    const stale = data<{ result: { native_json: string } }>(await inspect('filters.results', { offset: 0, limit: 1 }));
    assert.equal((JSON.parse(stale.result.native_json) as { current: boolean }).current, false);
    // #10877: replacement rows would shift the next offset even when the request keeps the same filter.
    const store = useViewerStore.getState(), published = store.searchFilterResult;
    assert.ok(published);
    store.setSearchFilterResult({ ...published, rows: published.rows.slice(1) });
    assert.equal((await inspect('filters.results', { offset, page_revision, limit: 2 })).errorCode, 'STATE_CHANGED');
  });
  it('uses native pick visibility and ownership while rejecting a scene changed during GPU readback', async () => {
    const models = new Map(useViewerStore.getState().models);
    models.set('A', { ...models.get('A')!, maxExpressId: 4 }); useViewerStore.setState({ models });
    const canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () => new DOMRect(10, 20, 400, 200);
    const options = { hiddenIds: new Set<number>(), isolatedIds: null, isStreaming: false };
    let started!: () => void, release!: () => void, defer = false;
    const began = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const matrix = new Float32Array(16);
    let clipRevision = 0;
    const renderer = {
      getGPUDevice: () => ({}), getCamera: () => ({ getViewProjMatrix: () => ({ m: matrix }) }), getPickClipRevision: () => clipRevision, getPickGeometryRevision: () => 0,
      async pick(x: number, y: number, nativeOptions: unknown) {
        assert.equal(x, 100); assert.equal(y, 100); assert.equal(nativeOptions, options);
        if (defer) { started(); await gate; }
        return { expressId: 1 };
      },
    } as unknown as Renderer;
    const unregister = registerAgentViewportHost({ canvas, renderer, getPickOptions: () => options });
    try {
      const picked = data<{ result: { ref_json: string } }>(await inspect('viewport.pick', { x: 0.25, y: 0.5 }));
      assert.deepEqual(JSON.parse(picked.result.ref_json), { modelId: 'A', expressId: 1 });
      assert.equal(useViewerStore.getState().selectedEntityId, null);
      defer = true;
      const pending = inspect('viewport.pick', { x: 0.25, y: 0.5 });
      await began; useViewerStore.getState().setSectionPlanePosition(123); release();
      assert.equal((await pending).isError, true);
      assert.equal(useViewerStore.getState().selectedEntityId, null);
      // A frame that applies a new clip during readback invalidates the hit even with no further store change.
      let startedAgain!: () => void; const beganAgain = new Promise<void>(resolve => { startedAgain = resolve; });
      let releaseAgain!: () => void; const gateAgain = new Promise<void>(resolve => { releaseAgain = resolve; });
      renderer.pick = async () => { startedAgain(); await gateAgain; return { expressId: 1 }; };
      const clipped = inspect('viewport.pick', { x: 0.25, y: 0.5 });
      await beganAgain; clipRevision += 1; releaseAgain();
      assert.equal((await clipped).isError, true);
      // Two independent agent reads do not supersede each other.
      renderer.pick = async () => ({ expressId: 1 });
      const [a, b] = await Promise.all([inspect('viewport.pick', { x: 0.25, y: 0.5 }), inspect('viewport.pick', { x: 0.25, y: 0.5 })]);
      assert.equal(a.isError, false, a.text); assert.equal(b.isError, false, b.text);
    } finally { unregister(); }
  });
  it('audits every built-in panel, tool and export while retaining native boundaries', async () => {
    const { viewerOperationCoverage } = await loadCoverageAudit();
    const report = viewerOperationCoverage();
    assert.equal(report.panel_count, WORKSPACE_PANELS.length); assert.equal(report.all_controls_automatable, false);
    assert.deepEqual(new Set(report.panels.map(panel => panel.id)), new Set(WORKSPACE_PANELS.map(panel => panel.id)));
    assert.deepEqual(report.panels.flatMap(panel => panel.gaps.map(gap => `${panel.id}: ${gap.id}: ${gap.reason}`)), []);
    assert.deepEqual(report.tools.flatMap(tool => tool.gaps.map(gap => `${tool.id}: ${gap.id}: ${gap.reason}`)), []);
    assert.deepEqual(report.exports.flatMap(item => item.gaps.map(gap => `${item.id}: ${gap.id}: ${gap.reason}`)), []);
    assert.equal(report.complete, true);
    assert.ok(report.panels.every(panel => panel.controls.length > 0));
    assert.ok(report.panels.some(panel => panel.controls.some(control => control.classification === 'native-boundary')));
    assert.ok(report.human_only.length > 0);
    // Boundaries are classified controls, not prose notes (#10592 review).
    const classes = (id: string) => report.panels.find(panel => panel.id === id)?.controls.map(control => control.classification) ?? [];
    assert.ok(classes('lists').includes('presentation-only'));
    assert.ok(classes('bcf').includes('native-boundary'));
    assert.ok(classes('hierarchy').includes('native-boundary'), 'unload with unexported changes keeps its native confirmation');
    // A joined control is marked grouped rather than claiming a per-control binding (#10592 review).
    assert.ok(report.panels.find(panel => panel.id === 'bcf')?.controls.some(control => 'grouped' in control && control.grouped === true));
    assert.ok(report.non_panel.find(row => row.id === 'preferences')?.notes?.length);
    for (const id of ['contextual-entity', 'tours-mobile']) assert.ok(report.non_panel.find(row => row.id === id)?.notes?.some(note => note.includes('bound to an audited')), id);
    assert.deepEqual(report.unbound_operations, [], 'every registered operation is bound to an audited control');
    // Non-panel families are bound to audited controls too, and count toward complete.
    assert.deepEqual(report.non_panel.flatMap(row => row.gaps.map(gap => `${row.id}: ${gap.id}: ${gap.reason}`)), []);
  });
  it('reports a toolbar export without an inventory entry as incomplete (#10592)', async () => {
    const { viewerOperationCoverage } = await loadCoverageAudit();
    const id = 'ion';
    assert.ok(EXPORT_COMMAND_IDS.includes(id));
    const inventory = nativeExportRegistryInventory.filter(row => row.registry_id !== id);
    const report = viewerOperationCoverage(inventory);
    // Ion has no registered operation, so only the toolbar comparison can detect the missing audit.
    assert.deepEqual(report.unbound_operations, []);
    assert.equal(report.complete, false);
    const entry = report.exports.find(row => row.id === id);
    assert.equal(entry?.complete, false);
    assert.deepEqual(entry?.gaps.map(gap => gap.id), [id]);
  });
  it('only names registered tools in the control audit (#10592)', async () => {
    const { auditedToolIds } = await loadCoverageAudit();
    const { toolControlAudits } = await import('./operations/coverage-audit');
    assert.deepEqual(Object.keys(toolControlAudits).filter(id => !auditedToolIds.includes(id)), []);
  });
  it('refuses bad operation tool arguments with the typed invalid-value reason (#10592)', async () => {
    const badLimit = await dispatchMainViewerTool(host, 'viewer_operation_coverage', { section: 'tools', limit: 0 });
    assert.equal(badLimit.isError, true); assert.equal((badLimit.structured as { reason?: string } | null)?.reason, 'invalid-value');
    const badJob = await dispatchMainViewerTool(host, 'viewer_operation_job', { job_id: 42 });
    assert.equal(badJob.isError, true); assert.equal((badJob.structured as { reason?: string } | null)?.reason, 'invalid-value');
  });
  it('summarizes coverage by default and serves bounded details on request (#10592)', async () => {
    const coverage = (args: Record<string, unknown> = {}) => dispatchMainViewerTool(host, 'viewer_operation_coverage', args);
    const summary = await coverage();
    const overview = data<{ complete: boolean; exports: unknown[] }>(summary);
    assert.equal(overview.complete, true);
    assert.deepEqual(overview.exports.find(row => typeof row === 'object' && row !== null && 'id' in row && row.id === 'ion'),
      { id: 'ion', complete: true, gap_count: 0, gap_ids: [] });
    assert.ok(Buffer.byteLength(summary.text) < 20_000);

    const { viewerOperationCoverage } = await loadCoverageAudit();
    const full = viewerOperationCoverage();
    const rows: typeof full.exports = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page: { rows: typeof rows; total: number; offset: number; next_offset: number | null } =
        data(await coverage({ section: 'exports', offset, limit: 5 }));
      assert.equal(page.total, full.exports.length);
      assert.equal(page.offset, offset);
      assert.ok(page.rows.length > 0 && page.rows.length <= 5);
      assert.equal(page.next_offset, offset + 5 < page.total ? offset + 5 : null);
      rows.push(...page.rows);
      offset = page.next_offset;
    }
    assert.deepEqual(rows, full.exports);

    const detail = data<{ rows: typeof full.panels; next_offset: number | null }>(await coverage({ section: 'panels', row_id: 'appearance' }));
    assert.deepEqual(detail.rows, full.panels.filter(row => row.id === 'appearance'));
    assert.equal(detail.next_offset, null);
    const boundaries = data<{ rows: typeof full.human_only }>(await coverage({ section: 'human_only', limit: 5 }));
    assert.deepEqual(boundaries.rows, full.human_only);
    for (const args of [{ limit: 1 }, { section: 'exports', limit: 6 }, { section: 'panels', row_id: 'ion' }, { section: 'nope' }]) {
      assert.equal((await coverage(args)).errorCode, 'INVALID_INPUT');
    }
  });
  it('refuses overflow coordinates and incomplete closed perimeters', async () => {
    assert.equal((await execute('measurements.distance', { start: [0, 0, 0], end: [1e308, 0, 0] })).isError, true);
    assert.equal(useViewerStore.getState().measurements.length, 0);
    assert.equal((await execute('measurements.polyline', { points: [[0, 0, 0], [0, 0, 0]], closed: true })).isError, true);
    assert.equal(useViewerStore.getState().polylineMeasurements.length, 0);
    assert.equal(useViewerStore.getState().activePolyline, null);
  });
  it('does not overwrite an in-progress pointer measurement', async () => {
    useViewerStore.getState().startMeasurement({ x: 1, y: 2, z: 3, screenX: 1, screenY: 2 });
    const current = useViewerStore.getState().activeMeasurement;
    assert.equal((await execute('measurements.distance', { start: [0, 0, 0], end: [1, 1, 1] })).isError, true);
    assert.equal(useViewerStore.getState().activeMeasurement, current);
  });
  it('honors native measurement and section feature denials', async () => {
    resetFeaturesForTest({ default: 'all', disable: ['tools.measure', 'tools.section'] });
    assert.equal((await execute('measurements.distance', { start: [0, 0, 0], end: [1, 1, 1] })).isError, true);
    assert.equal((await execute('section.replace', { planes: [] })).isError, true);
    resetFeaturesForTest();
  });
  it('applies lighting using the exact native panel setting action', async () => {
    useViewerStore.getState().setEnvExposure(1.6);
    const expected = data<{ result: unknown }>(await inspect('environment.read')).result;
    useViewerStore.getState().setEnvExposure(1);
    const applied = data<{ result: unknown }>(await execute('environment.exposure', { value: 1.6 }));
    assert.deepEqual(applied.result, expected);
  });
  it('rejects stale expected revisions before a setting changes', async () => {
    useViewerStore.setState({ mutationVersion: 3 });
    assert.equal((await execute('environment.exposure', { value: 1.1 }, { expected_revision: 2 })).errorCode, 'STATE_CHANGED');
  });
  it('runs real box-mesh clash analysis with structured job completion', async () => {
    const panelReport: ClashResult = { clashes: [], summary: summarizeClashes([]), rulesRun: [], settings: { tolerance: 0.002, excludeVoidsAndHosts: true } };
    useViewerStore.setState({ clashResult: panelReport });
    const rules = [{ id: 'walls', name: 'Wall pairs', a: 'IfcWall', b: 'IfcWall', mode: 'hard', tolerance: 0, clearance: 0 }];
    const queued = data<{ job: { id: string; state: string } }>(await inspect('clash.analyze', { rules }, { background: true }));
    assert.equal(queued.job.state, 'running');
    const terminal = data<{ state: string; result: { result: { clashes: unknown[] } } }>(await settled(queued.job.id));
    assert.equal(terminal.state, 'succeeded');
    assert.ok(terminal.result.result.clashes.length > 0, 'real coincident meshes must clash');
    assert.equal(useViewerStore.getState().clashResult, panelReport, 'analysis leaves the open panel report in place');
  });
  it('refuses completed job results after a model edit and isolates host job ownership', async () => {
    const queued = data<{ job: { id: string } }>(await inspect('schedule.tasks', {}, { background: true }));
    assert.equal(data<{ state: string }>(await settled(queued.job.id)).state, 'succeeded');
    const other = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
    assert.equal((await dispatchMainViewerTool(other, 'viewer_operation_job', { job_id: queued.job.id })).isError, true);
    useViewerStore.setState({ mutationVersion: 1 });
    assert.equal((await job(queued.job.id)).errorCode, 'STATE_CHANGED');
  });
  it('cancels a real clash job and waits for native runner settlement', async (t) => {
    // The runner signals entry, waits for the abort, then waits on a gate. While the gate is
    // closed the job must still be running: cancellation is not terminal until the runner settles.
    const gate = holdClashRunner(t);
    try {
      const rules = [{ id: 'walls', name: 'Wall pairs', a: 'IfcWall', b: 'IfcWall', mode: 'hard', tolerance: 0, clearance: 0 }];
      const queued = data<{ job: { id: string } }>(await inspect('clash.analyze', { rules }, { background: true }));
      await gate.entered;
      const requested = data<{ state: string; cancellationRequested?: boolean }>(await dispatchMainViewerTool(host, 'viewer_operation_cancel', { job_id: queued.job.id }));
      assert.equal(requested.state, 'running');
      assert.equal(requested.cancellationRequested, true);
      await gate.aborted;
      assert.equal(data<{ state: string }>(await job(queued.job.id)).state, 'running', 'cancelled only once the runner settles');
      gate.release();
      assert.equal(data<{ state: string }>(await settled(queued.job.id)).state, 'cancelled');
    } finally { gate.release(); }
  });
  it('discards a completed result when the model object changes even if its store survives', async () => {
    const queued = data<{ job: { id: string } }>(await inspect('schedule.tasks', {}, { background: true }));
    assert.equal(data<{ state: string }>(await settled(queued.job.id)).state, 'succeeded');
    const models = new Map(useViewerStore.getState().models);
    models.set('A', { ...models.get('A')!, name: 'replacement' });
    useViewerStore.setState({ models });
    assert.equal((await job(queued.job.id)).errorCode, 'STATE_CHANGED');
  });
  it('aborts host-owned analysis after its original MCP call has returned', async (t) => {
    const lifetime = new AbortController();
    host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }), { lifetimeSignal: lifetime.signal });
    const rules = [{ id: 'walls', name: 'Wall pairs', a: 'IfcWall', b: 'IfcWall', mode: 'hard', tolerance: 0, clearance: 0 }];
    const gate = holdClashRunner(t, { released: true });
    const queued = data<{ job: { id: string } }>(await inspect('clash.analyze', { rules }, { background: true }));
    await gate.entered;
    lifetime.abort();
    assert.equal(data<{ state: string }>(await settled(queued.job.id)).state, 'cancelled');
  });
  it('declares an explicit capability and closed runtime schema for every exact ID', () => {
    const ids = new Set<string>();
    for (const entry of viewerOperations()) {
      assert.equal(ids.has(entry.id), false); ids.add(entry.id);
      assert.ok(entry.effects.length > 0); assert.equal(entry.inputSchema.additionalProperties, false);
      assert.equal(entry.capability, entry.effects.every(effect => effect === 'read') ? 'read' : 'commands-and-edits');
    }
  });
});
