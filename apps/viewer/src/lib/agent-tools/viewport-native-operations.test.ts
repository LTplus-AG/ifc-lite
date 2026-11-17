/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { resetFeaturesForTest } from '@/lib/features';
import { createMainViewerToolHost } from './main-viewer-host';
import { dispatchMainViewerTool } from './main-viewer-dispatch';
const initial = useViewerStore.getState();
const host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
beforeEach(() => {
  resetFeaturesForTest();
  useViewerStore.setState({ models: new Map(), ifcDataStore: null, annotations: new Map(), draft: null });
});
afterEach(() => { useViewerStore.setState(initial); resetFeaturesForTest(); });
const execute = (id: string, input: Record<string, unknown>, canEdit = true) => dispatchMainViewerTool(host, 'viewer_operation_execute', { operation_id: id, input }, { canEdit: () => canEdit });
test('native section box rejects inverted and overflowing extents before changing the existing cut', async () => {
  const before = useViewerStore.getState().sectionPlane;
  for (const input of [{ min: [1, 0, 0], max: [0, 1, 1] }, { min: [-1e308, 0, 0], max: [1e308, 1, 1] }]) {
    assert.equal((await execute('section.box', input)).isError, true);
    assert.equal(useViewerStore.getState().sectionPlane, before);
  }
  const result = await execute('section.box', { min: [0, 0, 0], max: [1, 2, 3] });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(useViewerStore.getState().sectionPlane.box, { min: [0, 0, 0], max: [1, 2, 3] });
});
test('native annotation edits retain the open draft and reject stale records or a revoked grant', async () => {
  useViewerStore.getState().beginDraft({ x: 0, y: 0, z: 0 }, null, null);
  const draft = useViewerStore.getState().draft;
  assert.equal((await execute('annotations.create', { position: [1, 2, 3], note: 'note' })).isError, true);
  assert.equal(useViewerStore.getState().draft, draft);
  useViewerStore.getState().cancelDraft();
  const created = await execute('annotations.create', { position: [1, 2, 3], note: 'note' });
  assert.equal(created.isError, false, created.text);
  const id = [...useViewerStore.getState().annotations.keys()][0];
  const expected_json = JSON.stringify(useViewerStore.getState().annotations.get(id));
  assert.equal((await execute('annotations.manage', { id, expected_json, action: 'delete' }, false)).errorCode, 'READ_ONLY');
  useViewerStore.getState().updateAnnotation(id, 'changed by user');
  assert.equal((await execute('annotations.manage', { id, expected_json, action: 'delete' })).isError, true);
  assert.equal(useViewerStore.getState().annotations.get(id)?.note, 'changed by user');
});
test('discovery and execution use the same live section feature prerequisites', async () => {
  resetFeaturesForTest({ default: 'all', disable: ['tools.section'] });
  const detail = await dispatchMainViewerTool(host, 'viewer_operations', { operation_id: 'section.box' });
  assert.equal(detail.isError, false, detail.text);
  assert.match((detail.structured as { operations: Array<{ unavailable: string }> }).operations[0].unavailable, /tools.section/);
  const before = useViewerStore.getState().sectionPlane;
  assert.equal((await execute('section.box', { min: [0, 0, 0], max: [1, 2, 3] })).isError, true);
  assert.equal(useViewerStore.getState().sectionPlane, before);
});
