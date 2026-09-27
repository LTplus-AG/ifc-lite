/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5849 — cancelling a primary model load supersedes its session (so every
 * in-flight step stops at its next await) and returns the viewer to the
 * empty, idle state: no half-loaded model, no spinner, no error.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getViewerStoreApi } from '@/store';

// Dynamic: the revert oracle deletes this module, and a static import would
// fail the whole file instead of letting the assertions go red.
let installModelLoadCanceller: ((kind: 'primary' | 'federated', supersede: () => void) => () => void) | undefined;
try {
  ({ installModelLoadCanceller } = await import('./modelLoadCanceller.js'));
} catch (error) {
  console.error('[modelLoadCanceller.test] module unavailable; assertions will fail', error instanceof Error ? error.message : error);
}

const store = getViewerStoreApi();

function startLoading() {
  const s = store.getState();
  s.setLoading(true);
  s.setProgress({ phase: 'Processing geometry', percent: 50 });
  s.setError('stale error from an earlier attempt');
  // The placeholder record a primary load registers before parsing.
  s.addModel({
    id: 'loading-model',
    name: 'tower.ifc',
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: Date.now(),
    fileSize: 0,
    idOffset: 0,
    maxExpressId: 0,
    loadState: 'streaming-geometry',
  });
}

afterEach(() => {
  const s = store.getState();
  s.setActiveLoadCanceller(null);
  s.setActiveStreamCanceller(null);
  s.resetViewerState();
  s.clearAllModels();
});

describe('primary load cancel (#5849)', () => {
  it('publishes a canceller that supersedes the load and leaves the viewer empty and idle', () => {
    assert.ok(installModelLoadCanceller, 'hooks/modelLoadCanceller must export installModelLoadCanceller');
    startLoading();
    let superseded = 0;
    installModelLoadCanceller('primary', () => { superseded += 1; });

    const cancel = store.getState().activeLoadCanceller;
    assert.ok(cancel, 'a primary load publishes a canceller');
    // Not the point-cloud slot: device-loss recovery cancels that one, and a
    // model load has to survive a device loss.
    assert.equal(store.getState().activeStreamCanceller, null);
    cancel();

    const after = store.getState();
    assert.equal(superseded, 1, 'the load session is superseded');
    assert.equal(after.loading, false);
    assert.equal(after.progress, null);
    assert.equal(after.error, null, 'a user cancel is not an error');
    assert.equal(after.models.size, 0, 'the half-loaded model is gone');
    assert.equal(after.activeLoadCanceller, null, 'the Cancel control goes away');
  });

  it('release clears only its own canceller, never a newer load\'s', () => {
    assert.ok(installModelLoadCanceller);
    const releaseFirst = installModelLoadCanceller('primary', () => {});
    const releaseSecond = installModelLoadCanceller('primary', () => {});
    const second = store.getState().activeLoadCanceller;
    releaseFirst();
    assert.equal(store.getState().activeLoadCanceller, second, 'the newer load keeps its Cancel');
    releaseSecond();
    assert.equal(store.getState().activeLoadCanceller, null);
  });

  it('a retained cancel from a replaced load does nothing to the load that replaced it', () => {
    assert.ok(installModelLoadCanceller);
    let firstSuperseded = 0;
    installModelLoadCanceller('primary', () => { firstSuperseded += 1; });
    const staleCancel = store.getState().activeLoadCanceller;
    assert.ok(staleCancel);
    startLoading();
    installModelLoadCanceller('primary', () => {});
    const current = store.getState().activeLoadCanceller;

    staleCancel();

    const after = store.getState();
    assert.equal(firstSuperseded, 0, 'the stale cancel supersedes nothing');
    assert.equal(after.loading, true, 'the newer load keeps loading');
    assert.equal(after.models.size, 1, 'the newer load keeps its model record');
    assert.equal(after.activeLoadCanceller, current, 'the newer load keeps its Cancel');
  });

  it('also stops a point-cloud stream the primary load is running', () => {
    assert.ok(installModelLoadCanceller);
    let streamCancelled = 0;
    store.getState().setActiveStreamCanceller(() => { streamCancelled += 1; });
    installModelLoadCanceller('primary', () => {});
    store.getState().activeLoadCanceller?.();
    assert.equal(streamCancelled, 1, 'the stream is stopped, not just orphaned by the session bump');
    assert.equal(store.getState().activeStreamCanceller, null, 'no Cancel stays bound to the stopped stream');
  });

  it('a federated Cancel clears only load UI and preserves the existing model (#5849)', () => {
    assert.ok(installModelLoadCanceller);
    startLoading();
    store.getState().setLoadingFileName('added.ifc');
    const before = store.getState().models;
    let superseded = 0;
    installModelLoadCanceller('federated', () => { superseded += 1; });

    store.getState().activeLoadCanceller?.();

    const after = store.getState();
    assert.equal(superseded, 1);
    assert.equal(after.models, before, 'the previous model map is not reset');
    assert.equal(after.models.size, 1);
    assert.equal(after.loading, false);
    assert.equal(after.loadingFileName, null);
    assert.equal(after.progress, null);
    assert.equal(after.error, null);
    assert.equal(after.activeLoadCanceller, null);
  });
});
