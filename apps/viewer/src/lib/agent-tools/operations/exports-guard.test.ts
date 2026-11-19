/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { resetFeaturesForTest } from '@/lib/features';
import { WALL_ID, model, parseHelloWall, parseOther, seed, viewerHost } from '@/test/agent-tools-fixture';
import { dispatchMainViewerTool } from '../main-viewer-dispatch';
import { exportCheckpoint } from './exports-common';

const initial = useViewerStore.getState();
afterEach(() => { useViewerStore.setState(initial); resetFeaturesForTest(); });
const context = {} as Parameters<typeof exportCheckpoint>[0];
const geometry = (): GeometryResult => ({ meshes: [], totalTriangles: 0, totalVertices: 0,
  coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, hasLargeCoordinates: false } });
/**
 * Hide the wall the moment an operation reads a mutation view: after it captured the view state, so a guard that
 * watches the view must refuse. Were the hide earlier, the guard would capture it and the export would succeed.
 */
function hideWallOnMutationViewRead(): void {
  const getMutationView = useViewerStore.getState().getMutationView;
  useViewerStore.setState({ hiddenEntities: new Set(), getMutationView: (id: string) => {
    useViewerStore.setState({ hiddenEntities: new Set([WALL_ID]), getMutationView });
    return getMutationView(id);
  } });
}
const stepOptions = { schema: 'IFC4', include_geometry: false, apply_mutations: true, visible_only: false, section_mode: 'trim' };

test('switching the active model does not void an export of another model (#10695)', async () => {
  resetFeaturesForTest();
  const a = await parseHelloWall(), b = await parseOther();
  seed([model('A', a), model('B', b)]);
  useViewerStore.setState({ ifcDataStore: a });
  const check = exportCheckpoint(context, ['B']);
  useViewerStore.setState({ activeModelId: 'A', ifcDataStore: b });
  assert.doesNotThrow(check);
});

test('a legacy export is voided when its geometry is replaced (#10695)', async () => {
  resetFeaturesForTest();
  useViewerStore.setState({ models: new Map(), ifcDataStore: await parseHelloWall(), geometryResult: geometry() });
  const check = exportCheckpoint(context, ['__legacy__']);
  useViewerStore.setState({ geometryResult: geometry() });
  assert.throws(check, /changed during export/);
});

test('exports.modelStep exports a legacy single model (#10695)', async () => {
  resetFeaturesForTest();
  useViewerStore.setState({ models: new Map(), activeModelId: null, ifcDataStore: await parseHelloWall(), geometryResult: null, mutationVersion: 0 });
  const result = await dispatchMainViewerTool(viewerHost(), 'viewer_operation_execute', { operation_id: 'exports.modelStep', input: stepOptions }, { canEdit: () => true });
  assert.equal(result.isError, false, result.text);
  assert.match((result.structured as { result: { artifact: { filename: string } } }).result.artifact.filename, /\.ifc$/);
});

test('a visible-only STEP export is voided when the view changes, a full one is not (#10695)', async () => {
  resetFeaturesForTest();
  seed([model('A', await parseHelloWall())]);
  const host = viewerHost();
  const run = (visible_only: boolean) => dispatchMainViewerTool(host, 'viewer_operation_execute', { model_id: 'A', operation_id: 'exports.modelStep', input: { ...stepOptions, visible_only } }, { canEdit: () => true });
  hideWallOnMutationViewRead();
  const visible = await run(true);
  assert.equal(visible.isError, true, 'visible-only export must not publish a stale view');
  assert.match(visible.text, /visibility/);
  hideWallOnMutationViewRead();
  const full = await run(false);
  assert.equal(full.isError, false, full.text);
  assert.equal(useViewerStore.getState().hiddenEntities.size, 1, 'the hide landed during the full export too');
});

test('a composed layer is not exported as its own model (#10695)', async () => {
  resetFeaturesForTest();
  // The shape a federated IFCX composition publishes: every layer over one shared store, only the base with a parse range.
  const store = await parseHelloWall();
  seed([model('overlay', store, { idOffset: 0, maxExpressId: 0 }), model('base', store, { idOffset: 0, maxExpressId: 5_000 })]);
  const host = viewerHost();
  const json = (target_model_id: string) => dispatchMainViewerTool(host, 'viewer_operation_execute', { operation_id: 'exports.json', input: { target_model_id } }, { canEdit: () => true });
  const layer = await json('overlay');
  assert.equal(layer.isError, true);
  assert.match(layer.text, /Pass target_model_id 'base'/);
  const base = await json('base');
  assert.equal(base.isError, false, base.text);
});

test('changesJson and mergedStep refuse a composed layer too (#10695)', async () => {
  resetFeaturesForTest();
  const store = await parseHelloWall();
  seed([model('overlay', store, { idOffset: 0, maxExpressId: 0 }), model('base', store, { idOffset: 0, maxExpressId: 5_000 })]);
  const host = viewerHost();
  const run = (operation_id: string, input: Record<string, unknown>) => dispatchMainViewerTool(host, 'viewer_operation_execute', { operation_id, input }, { canEdit: () => true });
  const changes = await run('exports.changesJson', { target_model_id: 'overlay' });
  assert.match(changes.text, /Pass target_model_id 'base'/);
  const merged = await run('exports.mergedStep', { ...stepOptions, include_geometry: true, model_ids: ['overlay', 'base'], unit_reconciliation: 'assume-shared' });
  assert.match(merged.text, /List 'base' in model_ids in its place/);
});

test('a visible-only IFCX export is voided when the view changes (#10695)', async () => {
  resetFeaturesForTest();
  seed([model('A', await parseHelloWall())]);
  const host = viewerHost();
  hideWallOnMutationViewRead();
  const result = await dispatchMainViewerTool(host, 'viewer_operation_execute', { model_id: 'A', operation_id: 'exports.modelIfcx', input: {
    include_geometry: false, apply_mutations: true, visible_only: true, changes_only: false, only_known_properties: false } }, { canEdit: () => true });
  assert.equal(result.isError, true, 'visible-only IFCX must not publish a stale view');
  assert.match(result.text, /visibility/);
});

