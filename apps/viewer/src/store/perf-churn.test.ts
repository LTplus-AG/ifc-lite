/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffCounters, perfCounters } from '@ifc-lite/load-trace';

// The counters are switched on BEFORE the store module evaluates, as the
// viewer's perfTraceFlag does under ?perfTrace=1.
perfCounters.enable();
const { useViewerStore } = await import('./index.js');

describe('viewer store churn counters (#6957)', () => {
  it('counts every write once, through slice actions and useViewerStore.setState alike', () => {
    const notified: unknown[] = [];
    const unsubscribe = useViewerStore.subscribe((s) => notified.push(s.hoverHighlightEnabled));
    const before = perfCounters.read();

    useViewerStore.getState().toggleHoverHighlight(); // a slice `set`, under the visibility middleware
    useViewerStore.setState({ hoverHighlightEnabled: true }); // the store API setter
    // A visibility-channel write goes through the invalidation middleware's own
    // api.setState replacement; it must still be counted once, not twice.
    useViewerStore.setState({ isolatedEntities: new Set([1]) });
    unsubscribe();
    useViewerStore.getState().toggleHoverHighlight(); // no subscriber of ours any more

    const delta = diffCounters(perfCounters.read(), before);
    assert.equal(delta['store.setState'], 4);
    assert.equal(notified.length, 3);
    // Our listener ran 3 times; other module-level subscriptions the store
    // registers at creation run too, so notifications >= our share.
    assert.ok((delta['store.notifications'] ?? 0) >= 3, JSON.stringify(delta));
  });
});
