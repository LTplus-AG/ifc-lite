/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createBimContext } from '@ifc-lite/sdk';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { seedCoincidentWalls } from '@/test/clash-run-fixture';
import { resetFeaturesForTest } from '@/lib/features';
import { createMainViewerToolHost } from './main-viewer-host';
import { dispatchMainViewerTool } from './main-viewer-dispatch';
import { viewerOperationCoverage } from './operations/coverage';
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
  dispatchMainViewerTool(host, 'viewer_operation_execute', { model_id: 'A', operation_id: id, input, ...extra }, { canEdit: () => canEdit });
const inspect = (id: string, input: unknown = {}, extra: Record<string, unknown> = {}) =>
  dispatchMainViewerTool(host, 'viewer_operation_inspect', { model_id: 'A', operation_id: id, input, ...extra });
const job = (job_id: string) => dispatchMainViewerTool(host, 'viewer_operation_job', { job_id });
function data<T>(value: { structured: unknown; isError: boolean; text: string }): T { assert.equal(value.isError, false, value.text); return value.structured as T; }
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
      model_id: 'A', operation_id: 'environment.exposure', input: { value: 1.7 },
    }, { canEdit: () => granted });
    granted = false;
    assert.equal((await pending).errorCode, 'READ_ONLY');
  });
  it('validates all model-local entity IDs before changing either selection channel', async () => {
    assert.equal((await execute('selection.replace', { express_ids: [1, 987654] })).errorCode, 'ENTITY_NOT_FOUND');
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
  it('covers all panel IDs while exposing each incomplete workflow as a real gap', () => {
    const report = viewerOperationCoverage();
    assert.equal(report.panel_count, 35); assert.equal(report.complete, false);
    assert.deepEqual(new Set(report.panels.map(panel => panel.id)), new Set(WORKSPACE_PANELS.map(panel => panel.id)));
    assert.ok(report.panels.every(panel => panel.complete === false && panel.gaps.length > 0));
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
    const rules = [{ id: 'walls', name: 'Wall pairs', a: 'IfcWall', b: 'IfcWall', mode: 'hard', tolerance: 0, clearance: 0 }];
    const queued = data<{ job: { id: string; state: string } }>(await inspect('clash.analyze', { rules }, { background: true }));
    assert.equal(queued.job.state, 'running');
    const terminal = data<{ state: string; result: { result: { clashes: unknown[] } } }>(await settled(queued.job.id));
    assert.equal(terminal.state, 'succeeded');
    assert.ok(terminal.result.result.clashes.length > 0, 'real coincident meshes must clash');
    assert.equal(useViewerStore.getState().clashResult, null, 'analysis does not replace the panel report');
  });
  it('refuses completed job results after a model edit and isolates host job ownership', async () => {
    const queued = data<{ job: { id: string } }>(await inspect('schedule.tasks', {}, { background: true }));
    assert.equal(data<{ state: string }>(await settled(queued.job.id)).state, 'succeeded');
    const other = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
    assert.equal((await dispatchMainViewerTool(other, 'viewer_operation_job', { job_id: queued.job.id })).isError, true);
    useViewerStore.setState({ mutationVersion: 1 });
    assert.equal((await job(queued.job.id)).errorCode, 'STATE_CHANGED');
  });
  it('cancels a real clash job and waits for native runner settlement', async () => {
    const rules = [{ id: 'walls', name: 'Wall pairs', a: 'IfcWall', b: 'IfcWall', mode: 'hard', tolerance: 0, clearance: 0 }];
    const queued = data<{ job: { id: string } }>(await inspect('clash.analyze', { rules }, { background: true }));
    const requested = await dispatchMainViewerTool(host, 'viewer_operation_cancel', { job_id: queued.job.id });
    assert.equal(requested.isError, false, requested.text);
    const terminal = data<{ state: string }>(await settled(queued.job.id));
    assert.equal(terminal.state, 'cancelled');
  });
  it('discards a completed result when the model object changes even if its store survives', async () => {
    const queued = data<{ job: { id: string } }>(await inspect('schedule.tasks', {}, { background: true }));
    assert.equal(data<{ state: string }>(await settled(queued.job.id)).state, 'succeeded');
    const models = new Map(useViewerStore.getState().models);
    models.set('A', { ...models.get('A')!, name: 'replacement' });
    useViewerStore.setState({ models });
    assert.equal((await job(queued.job.id)).errorCode, 'STATE_CHANGED');
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
