/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Regression for #4989/#5005: exercise the real assembled store reset, not
 * the compare teardown helper in isolation. */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from './index.js';

describe('resetViewerState — compare authored-key scheme', () => {
  it('drops the outgoing files\' scheme while preserving session preferences', () => {
    useViewerStore.setState({
      compareKeyProperty: 'Pset_Asset.AssetId',
      compareScope: 'data',
      compareMatchByContent: false,
      compareShowUnchanged: true,
    });
    assert.equal(useViewerStore.getState().compareKeyProperty, 'Pset_Asset.AssetId');

    useViewerStore.getState().resetViewerState();

    const reset = useViewerStore.getState();
    assert.equal(reset.compareKeyProperty, undefined);
    assert.equal(reset.compareScope, 'data');
    assert.equal(reset.compareMatchByContent, false);
    assert.equal(reset.compareShowUnchanged, true);
  });
});
