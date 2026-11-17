/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { LoadTrace } from '@ifc-lite/load-trace';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { isGeometryHeld } from './pick-gating.js';
import {
  RESTORE_BACKSTOP_MS, beginGeometryRestore, endGeometryRestore, geometryRestoreBackstopFires, publishMetadataAtMark,
} from './geometry-restore-gate.js';
import { settleOwnedLoadUi } from '@/hooks/modelLoadCanceller.js';

function addModel(id: string): void {
  useViewerStore.getState().upsertModel({
    id, name: `${id}.ifc`, ifcDataStore: null, geometryResult: null, visible: true, collapsed: false, schemaVersion: 'IFC4',
    loadedAt: 0, fileSize: 1, idOffset: 0, maxExpressId: 0, loadState: 'streaming-geometry',
  } as Parameters<ReturnType<typeof useViewerStore.getState>['upsertModel']>[0]);
}
const held = () => isGeometryHeld(useViewerStore.getState());
const pending = (id: string) => useViewerStore.getState().models.get(id)?.geometryRestorePending === true;

describe('geometry restore gate (reopen mark, 2026-11-14)', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
    useViewerStore.getState().resetViewerState();
    useViewerStore.getState().clearAllModels();
  });
  afterEach(() => { mock.timers.reset(); });

  it('holds geometry interaction while a model is pending, and only then', () => {
    addModel('a');
    assert.equal(held(), false);
    beginGeometryRestore('a');
    assert.equal(pending('a'), true);
    assert.equal(held(), true);
    endGeometryRestore('a');
    assert.equal(held(), false);
    endGeometryRestore('a'); // idempotent
    assert.equal(held(), false);
  });

  it('normal restore: the load end (settleOwnedLoadUi) releases it; the backstop never fires', () => {
    const before = geometryRestoreBackstopFires();
    addModel('a');
    beginGeometryRestore('a');
    settleOwnedLoadUi(() => {}, null, 'a');
    assert.equal(held(), false);
    mock.timers.tick(RESTORE_BACKSTOP_MS + 1);
    assert.equal(geometryRestoreBackstopFires(), before);
  });

  it('failed restore: a failed load ends through the same settle with its model id, so the hold is released', () => {
    const before = geometryRestoreBackstopFires();
    addModel('a');
    beginGeometryRestore('a');
    useViewerStore.getState().updateModel('a', { loadState: 'error', loadError: 'chunk decode failed' });
    settleOwnedLoadUi(() => {}, { phase: 'Error', percent: 0 }, 'a');
    assert.equal(held(), false);
    mock.timers.tick(RESTORE_BACKSTOP_MS + 1);
    assert.equal(geometryRestoreBackstopFires(), before);
  });

  it('superseded restore: the next primary reset removes the model, which ends the hold; the backstop does not count it', () => {
    const before = geometryRestoreBackstopFires();
    addModel('old');
    beginGeometryRestore('old');
    useViewerStore.getState().resetViewerState();
    useViewerStore.getState().clearAllModels(); // a superseding primary load's reset
    assert.equal(held(), false);
    mock.timers.tick(RESTORE_BACKSTOP_MS + 1);
    assert.equal(geometryRestoreBackstopFires(), before);
  });

  it('multi-file open: only the models still restoring hold; an ended one does not keep the gate', () => {
    addModel('a'); addModel('b');
    beginGeometryRestore('a'); beginGeometryRestore('b');
    settleOwnedLoadUi(() => {}, null, 'a');
    assert.equal(pending('a'), false);
    assert.equal(held(), true, 'b still restoring');
    settleOwnedLoadUi(() => {}, null, 'b');
    assert.equal(held(), false);
  });

  it('a hold whose load end never comes is ended by the backstop, which counts and warns', () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      const before = geometryRestoreBackstopFires();
      addModel('stuck');
      beginGeometryRestore('stuck');
      mock.timers.tick(RESTORE_BACKSTOP_MS - 1);
      assert.equal(held(), true);
      mock.timers.tick(1);
      assert.equal(held(), false);
      assert.equal(geometryRestoreBackstopFires(), before + 1);
      assert.equal(warn.mock.callCount(), 1);
    } finally { warn.mock.restore(); }
  });

  it('publishMetadataAtMark: store out now, model held, mark emitted once the stored scene is shown', async () => {
    addModel('a');
    useViewerStore.getState().setActiveModel('a');
    const marks: string[] = [];
    const trace = { span: (_n: string, fn: () => unknown) => fn(), milestone: (n: string) => { marks.push(n); } } as unknown as LoadTrace;
    let shown!: () => void;
    const sceneShown = new Promise<void>((resolve) => { shown = resolve; });
    const store = { schemaVersion: 'IFC4' } as unknown as IfcDataStore;
    publishMetadataAtMark('a', store, sceneShown, trace);
    assert.equal(useViewerStore.getState().ifcDataStore, store, 'metadata store published before the geometry restore');
    assert.equal(held(), true);
    await Promise.resolve();
    assert.deepEqual(marks, [], 'no mark before the stored scene is shown');
    shown();
    await sceneShown; await Promise.resolve();
    assert.deepEqual(marks, ['load.metadataInteractive']);
    endGeometryRestore('a');
  });

  it('publishMetadataAtMark: a load cancelled or superseded before the scene is shown emits no mark', async () => {
    addModel('a');
    useViewerStore.getState().setActiveModel('a');
    const marks: string[] = [];
    const trace = { span: (_n: string, fn: () => unknown) => fn(), milestone: (n: string) => { marks.push(n); } } as unknown as LoadTrace;
    let shown!: () => void;
    const sceneShown = new Promise<void>((resolve) => { shown = resolve; });
    let stale = false;
    publishMetadataAtMark('a', { schemaVersion: 'IFC4' } as unknown as IfcDataStore, sceneShown, trace, () => stale);
    stale = true; // superseded while the stored scene was still on its way
    shown();
    await sceneShown; await Promise.resolve();
    assert.deepEqual(marks, [], 'a stale load must not report a reopen as interactive');
    endGeometryRestore('a');
  });
});

