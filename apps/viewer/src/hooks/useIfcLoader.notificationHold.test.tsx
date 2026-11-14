/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A primary load's notification hold (store/notification-batch.ts) never needs
 * its microtask backstop: the loader releases it itself on the completed, the
 * failed and the superseded path, and subscribers still see the load start.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { notificationBackstopReleases } from '@/store/notification-batch.js';
import { hook, skip, blankFile } from '@/test/blank-ifc-loader-harness.js';

function watchLoadingStart() {
  let sawLoading = false;
  const off = useViewerStore.subscribe((s, p) => { if (s.loading && !p.loading) sawLoading = true; });
  return { off, saw: () => sawLoading };
}

describe('primary load notification hold (#10196)', () => {
  it('a completed primary load releases its hold itself', { skip }, async () => {
    assert.ok(hook);
    const before = notificationBackstopReleases(); const w = watchLoadingStart();
    await act(async () => hook!.loadFile(blankFile('METRE'), { kind: 'primary' }));
    await Promise.resolve();
    w.off();
    const model = useViewerStore.getState().models.get(useViewerStore.getState().activeModelId ?? '');
    assert.equal(model?.loadState, 'complete');
    assert.equal(w.saw(), true, 'subscribers saw loading turn on');
    assert.equal(notificationBackstopReleases(), before, 'the backstop never had to release a loader hold');
  });

  it('a failed primary load releases its hold itself', { skip }, async () => {
    assert.ok(hook);
    const before = notificationBackstopReleases(); const w = watchLoadingStart();
    const broken = new File(['{ this is not valid json'], 'broken.ifcx', { type: 'application/json' });
    await act(async () => hook!.loadFile(broken, { kind: 'primary' }));
    await Promise.resolve();
    w.off();
    assert.equal(useViewerStore.getState().loading, false, 'the failed load ended');
    assert.equal(w.saw(), true);
    assert.equal(notificationBackstopReleases(), before);
  });

  it('a primary load superseded by another releases both holds itself', { skip }, async () => {
    assert.ok(hook);
    const before = notificationBackstopReleases(); const w = watchLoadingStart();
    await act(async () => {
      const first = hook!.loadFile(blankFile('METRE'), { kind: 'primary' });
      const second = hook!.loadFile(blankFile('MILLIMETRE'), { kind: 'primary' });
      await Promise.all([first, second]);
    });
    await Promise.resolve();
    w.off();
    const state = useViewerStore.getState();
    assert.equal(state.models.size, 1, 'only the superseding load is resident');
    assert.equal(state.models.get(state.activeModelId ?? '')?.name, 'blank-mm.ifc');
    assert.equal(w.saw(), true);
    assert.equal(notificationBackstopReleases(), before);
  });
});
