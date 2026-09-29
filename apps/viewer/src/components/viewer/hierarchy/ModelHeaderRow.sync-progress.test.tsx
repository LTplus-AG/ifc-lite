/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hierarchy's per-model Sync button draws the same progress ring as a
 * Sources file download (#6375), fed live by the running sync's download,
 * and falls back to the spinning sync arrows while there is nothing to
 * measure (listing, parsing, or no size).
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { setSourceSyncProgress } from '@/lib/sources/downloadProgress';
import { ModelHeaderRow } from './ModelHeaderRow.js';
import type { TreeNode } from './types.js';

const node: TreeNode = {
  id: 'model-A',
  expressIds: [],
  globalIds: [],
  modelIds: ['A'],
  name: 'A.ifc',
  type: 'model-header',
  depth: 0,
  hasChildren: true,
  isExpanded: false,
  isVisible: true,
  elementCount: 12,
};

function mount(sourceSyncing: boolean): HTMLElement {
  return render(
    <ModelHeaderRow
      node={node}
      virtualRow={{ size: 28, start: 0 }}
      modelsCount={1}
      modelVisible
      onModelVisibilityToggle={() => {}}
      onRemoveModel={() => {}}
      onSyncSourceModel={() => {}}
      onModelHeaderClick={() => {}}
      sourceBacked
      sourceSyncing={sourceSyncing}
    />,
  );
}

afterEach(() => {
  act(() => setSourceSyncProgress('A', undefined));
  cleanup();
});

describe('ModelHeaderRow Sync progress (#6375)', () => {
  it('follows the sync download as a ring, then returns to the spinning arrows', () => {
    const row = mount(true);
    assert.equal(row.querySelector('[role="progressbar"]'), null, 'no ring before the download reports');
    assert.ok(row.querySelector('.animate-spin'), 'the arrows spin while the sync lists the source');

    act(() => setSourceSyncProgress('A', { phase: 'downloading', received: 25, total: 100 }));
    const ring = row.querySelector('[role="progressbar"]');
    assert.equal(ring?.getAttribute('aria-valuenow'), '25');
    assert.equal(ring?.getAttribute('aria-label'), 'Downloading the latest revision of A.ifc');

    act(() => setSourceSyncProgress('A', { phase: 'downloading', received: 75, total: 100 }));
    assert.equal(row.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'), '75');

    act(() => setSourceSyncProgress('A', undefined));
    assert.equal(row.querySelector('[role="progressbar"]'), null, 'the ring goes once the bytes are in');
    assert.ok(row.querySelector('.animate-spin'), 'the parse reads as the plain busy state');
  });

  it('shows no ring on a row that is not syncing, whatever the store holds', () => {
    const row = mount(false);
    act(() => setSourceSyncProgress('B', { phase: 'downloading', received: 1, total: 2 }));
    act(() => setSourceSyncProgress('A', { phase: 'downloading', received: 1, total: 2 }));
    assert.equal(row.querySelector('[role="progressbar"]'), null, 'a row that is not syncing never rings');
    act(() => setSourceSyncProgress('B', undefined));
  });
});
