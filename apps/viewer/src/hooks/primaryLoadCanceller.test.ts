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
let installPrimaryLoadCanceller: ((supersede: () => void) => () => void) | undefined;
try {
  ({ installPrimaryLoadCanceller } = await import('./primaryLoadCanceller.js'));
} catch (error) {
  console.error('[primaryLoadCanceller.test] module unavailable; assertions will fail', error instanceof Error ? error.message : error);
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
  s.setActiveStreamCanceller(null);
  s.resetViewerState();
  s.clearAllModels();
});

describe('primary load cancel (#5849)', () => {
  it('publishes a canceller that supersedes the load and leaves the viewer empty and idle', () => {
    assert.ok(installPrimaryLoadCanceller, 'hooks/primaryLoadCanceller must export installPrimaryLoadCanceller');
    startLoading();
    let superseded = 0;
    installPrimaryLoadCanceller(() => { superseded += 1; });

    const cancel = store.getState().activeStreamCanceller;
    assert.ok(cancel, 'a primary load publishes a canceller');
    cancel();

    const after = store.getState();
    assert.equal(superseded, 1, 'the load session is superseded');
    assert.equal(after.loading, false);
    assert.equal(after.progress, null);
    assert.equal(after.error, null, 'a user cancel is not an error');
    assert.equal(after.models.size, 0, 'the half-loaded model is gone');
    assert.equal(after.activeStreamCanceller, null, 'the Cancel control goes away');
  });

  it('release clears only its own canceller, never a newer load\'s', () => {
    assert.ok(installPrimaryLoadCanceller);
    const releaseFirst = installPrimaryLoadCanceller(() => {});
    const releaseSecond = installPrimaryLoadCanceller(() => {});
    const second = store.getState().activeStreamCanceller;
    releaseFirst();
    assert.equal(store.getState().activeStreamCanceller, second, 'the newer load keeps its Cancel');
    releaseSecond();
    assert.equal(store.getState().activeStreamCanceller, null);
  });
});
