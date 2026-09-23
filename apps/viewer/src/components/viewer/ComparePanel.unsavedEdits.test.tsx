/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5312 (#5214 finding 2, warn half): Compare's data channel reads the
 * parsed store, not the mutation overlay — `buildDataInput.ts`,
 * `buildFingerprints.ts` and `compareScope.ts`'s `comparableProductIds` all
 * ignore `MutablePropertyView`, while the geometry channel is live
 * (`removeEntity` prunes the mesh). So a model with unsaved viewer edits is
 * silently compared as-loaded, and the user has no way to tell.
 *
 * `dirtyModels` already tracks unsaved edits (`ExportDialog.tsx` already
 * consumes it). This is the warn-only half: `ComparePanel` must surface a
 * warning when either the A/B picker selection or the currently-shown
 * result's compared pair has a dirty model — NOT make Compare read the
 * overlay (that bake half is the separate #5236-charter follow-up).
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types.js';
import { resolve } from '@/i18n/registry';
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

const WARNING_TEXT = resolve('comparePanel.runControls.unsavedEditsWarning' as never);

describe('ComparePanel unsaved-edits warning (#5312)', () => {
  it('warns when the A/B picker selects a model with unsaved viewer edits', () => {
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
    assert.ok(
      container.textContent?.includes(WARNING_TEXT),
      'expected the unsaved-edits warning to be on screen when the head model is dirty',
    );
  });

  it('does not warn when neither compared model is dirty', () => {
    useViewerStore.setState({
      models: new Map([
        ['A', model('A')],
        ['B', model('B')],
      ]),
      compareBaseModelId: 'A',
      compareHeadModelId: 'B',
      dirtyModels: new Set<string>(),
    });
    const container = render(<ComparePanel onClose={() => {}} />);
    assert.ok(
      !container.textContent?.includes(WARNING_TEXT),
      'the warning must not appear when no compared model has unsaved edits',
    );
  });

  it('does not warn when a DIFFERENT (uncompared) model is dirty', () => {
    useViewerStore.setState({
      models: new Map([
        ['A', model('A')],
        ['B', model('B')],
        ['C', model('C')],
      ]),
      compareBaseModelId: 'A',
      compareHeadModelId: 'B',
      dirtyModels: new Set(['C']),
    });
    const container = render(<ComparePanel onClose={() => {}} />);
    assert.ok(
      !container.textContent?.includes(WARNING_TEXT),
      'a dirty model that is not part of this A/B pair must not trigger the warning',
    );
  });
});
