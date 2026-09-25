/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compare fingerprints the models as edited, not as loaded (#5312, see
 * `effectiveCompareStore.ts` and `useCompare.liveEdits.test.tsx`). The #5312
 * warn-only notice that said the opposite ("Compare reads the file as loaded,
 * not those edits") outlived the fix; #5606 removed it. A dirty compared model
 * must not bring it back.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types.js';
import { ComparePanel } from './ComparePanel.js';

function model(id: string): FederatedModel {
  return {
    id,
    name: `${id}.ifc`,
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 0,
    idOffset: 0,
    maxExpressId: 10,
  } as FederatedModel;
}

const RESET_STATE = {
  models: new Map(),
  compareBaseModelId: null,
  compareHeadModelId: null,
  compareResult: null,
  compareSelectedKey: null,
  compareRunning: false,
  compareError: null,
  dirtyModels: new Set<string>(),
};

beforeEach(() => {
  useViewerStore.setState(RESET_STATE);
});

afterEach(() => {
  cleanup();
  useViewerStore.setState(RESET_STATE);
});

describe('ComparePanel with unsaved edits (#5606)', () => {
  it('does not claim Compare ignores the edits when a compared model is dirty', () => {
    useViewerStore.setState({
      models: new Map([
        ['A', model('A')],
        ['B', model('B')],
      ]),
      compareBaseModelId: 'A',
      compareHeadModelId: 'B',
      dirtyModels: new Set(['B']),
    });
    const container = render(<ComparePanel onClose={() => {}} />);
    const text = container.textContent ?? '';
    assert.doesNotMatch(text, /as loaded/, 'Compare reads the edited models, so no "reads the file as loaded" notice');
    assert.doesNotMatch(text, /unsaved viewer edits/);
  });
});
