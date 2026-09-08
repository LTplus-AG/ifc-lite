/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { federationRegistry } from '@ifc-lite/renderer';
import { useViewerStore } from './index.js';
import type { FederatedModel } from './types.js';
import type { CompareResult } from './slices/compareSlice.js';
import { buildCompareOverlay } from '../lib/compare/overlay.js';

function model(id: string, idOffset: number, maxExpressId: number): FederatedModel {
  return { id, name: id, visible: true, idOffset, maxExpressId } as unknown as FederatedModel;
}

function emptyDiff(): CompareResult['diff'] {
  return {
    scope: 'data',
    excludedTypes: [],
    entries: [],
    byKey: new Map(),
    counts: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
  } as unknown as CompareResult['diff'];
}

function makeCompareResult(): CompareResult {
  return {
    baseModelId: 'A',
    headModelId: 'B',
    baseName: 'A',
    headName: 'B',
    scope: 'data',
    geometryUnavailable: false,
    excludedHiddenIds: new Set([42, 1005]),
    diff: emptyDiff(),
  };
}

describe('compareResult (incl. excludedHiddenIds) survives model teardown as a dangling — and, after a georef reload, misresolvable — reference', () => {
  it('clearAllModels now clears compareResult, closing the offset-reuse misresolution window', () => {
    // Reproduces GeoreferencingPanel.tsx's `reloadModelsForAlignment`:
    // `clearAllModels()` directly, WITHOUT `resetViewerState()` (the only
    // other place compareResult was ever cleared), followed by reloading
    // every model. `federationRegistry.clear()` resets the offset counter to
    // 0, so the first model registered after the clear can be handed the
    // exact offsets an un-cleared compareResult's ids describe.
    federationRegistry.clear();
    federationRegistry.registerModel('A', 100);
    federationRegistry.registerModel('B', 100);
    useViewerStore.setState({
      models: new Map([
        ['A', model('A', 0, 100)],
        ['B', model('B', 1000, 1100)],
      ]),
      activeModelId: 'A',
    });
    useViewerStore.getState().setCompareResult(makeCompareResult());

    useViewerStore.getState().clearAllModels();

    const afterClear = useViewerStore.getState();
    console.log('compareResult after clearAllModels:', afterClear.compareResult);
    assert.strictEqual(
      afterClear.compareResult,
      null,
      'clearAllModels must drop compareResult — every pairing it could describe is gone',
    );

    // Reload a model — offset space was reset, so it can land on the same
    // offsets the (now-cleared) old result used to describe. With
    // compareResult null, there is nothing left to misresolve.
    const newOffsetC = federationRegistry.registerModel('C', 50);
    assert.strictEqual(newOffsetC, 0, 'offset space is not burned across a full clear — confirms the hazard is real');
    useViewerStore.getState().addModel(model('C', newOffsetC, 50));
    assert.strictEqual(useViewerStore.getState().compareResult, null, 'reload must not resurrect a stale comparison');
  });

  it('removeModel clears compareResult when the removed model was the base or head of the comparison', () => {
    federationRegistry.clear();
    federationRegistry.registerModel('A', 100);
    federationRegistry.registerModel('B', 100);
    useViewerStore.setState({
      models: new Map([
        ['A', model('A', 0, 100)],
        ['B', model('B', 1000, 1100)],
      ]),
      activeModelId: 'A',
    });
    useViewerStore.getState().setCompareResult(makeCompareResult());

    useViewerStore.getState().removeModel('B');

    assert.strictEqual(
      useViewerStore.getState().compareResult,
      null,
      'removing the HEAD model of an active comparison must drop the (now half-describing) result',
    );
  });

  it('negative control: removeModel on a model NOT party to the comparison leaves compareResult untouched', () => {
    // Proves the removeModel fix is not a blanket clear — a third federated
    // sibling leaving does not invalidate a comparison between two OTHER
    // still-loaded models.
    federationRegistry.clear();
    federationRegistry.registerModel('A', 100);
    federationRegistry.registerModel('B', 100);
    federationRegistry.registerModel('C', 100);
    useViewerStore.setState({
      models: new Map([
        ['A', model('A', 0, 100)],
        ['B', model('B', 1000, 1100)],
        ['C', model('C', 2000, 2100)],
      ]),
      activeModelId: 'A',
    });
    const result = makeCompareResult();
    useViewerStore.getState().setCompareResult(result);

    useViewerStore.getState().removeModel('C');

    const after = useViewerStore.getState();
    console.log('compareResult after removing an uninvolved model:', after.compareResult);
    assert.strictEqual(
      after.compareResult,
      result,
      'a comparison between A and B must survive the removal of an unrelated model C',
    );

    // And the excludedHiddenIds channel still resolves correctly against the
    // surviving A/B federation — nothing was disturbed.
    const { hiddenIds } = buildCompareOverlay(result.diff, false, result.excludedHiddenIds);
    assert.deepStrictEqual(hiddenIds, new Set([42, 1005]));
  });
});
