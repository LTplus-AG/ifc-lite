/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A primary load's synchronous reset (resetViewerState, clearAllModels,
 * clearLayerStack, the loading flags, the placeholder model) reaches each store
 * subscriber once, not once per write (#10196). Observed through the public
 * store and loader only: count a subscriber's callbacks during the
 * synchronous part of `loadFile`, which ends before its first await.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { hook, skip, blankFile } from '@/test/blank-ifc-loader-harness.js';

describe('primary load reset notifications (#10196)', () => {
  it('a subscriber runs once (not once per write) for the whole synchronous reset, and sees the reset state', { skip }, async () => {
    assert.ok(hook);
    const seen: Array<{ loading: boolean; models: number }> = [];
    const off = useViewerStore.subscribe((s) => seen.push({ loading: s.loading, models: s.models.size }));
    let pending: Promise<unknown> | undefined;
    try {
      pending = hook!.loadFile(blankFile('METRE'), { kind: 'primary' });
      const during = seen.length; // the synchronous part of loadFile has returned
      // ~30 without the hold (one per write); a write made by another subscriber during the flush may add one or two.
      assert.ok(during >= 1 && during <= 3, `the reset reached the subscriber ${during} times`);
      // The loader's own write before the reset (the active-load canceller) may notify first; the reset's single callback is the last.
      assert.deepEqual(seen.at(-1), { loading: true, models: 1 }, 'the reset callback already shows the new load and its placeholder');
    } finally {
      await act(async () => { await pending; });
      off();
    }
  });
});
