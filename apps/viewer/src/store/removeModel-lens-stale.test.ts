/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { federationRegistry } from '@ifc-lite/renderer';
import { useViewerStore } from './index.js';
import type { FederatedModel } from './types.js';

function model(id: string, idOffset: number, maxExpressId: number): FederatedModel {
  return { id, name: id, visible: true, idOffset, maxExpressId } as unknown as FederatedModel;
}

/** Seeds the store as if `useLens.ts`'s effect had just evaluated an active
 *  lens against a 2-model federation (A offset 0, B offset 1000) — exactly
 *  the fields that effect writes on every evaluation. */
function seedActiveLensState(): void {
  useViewerStore.setState({
    activeLensId: 'lens-1',
    lensColorMap: new Map([[42, '#ff0000'], [1005, '#00ff00']]),
    lensAppliedColors: new Map([[42, [1, 0, 0, 1]], [1005, [0, 1, 0, 1]]]),
    lensHiddenIds: new Set([7, 1008]),
    lensAppliedHiddenIds: [7, 1008],
    lensRuleCounts: new Map([['rule-1', 2]]),
    lensRuleEntityIds: new Map([['rule-1', [42, 1005]]]),
  });
}

describe('clearAllModels leaves an active lens\'s computed maps stale — offset-reuse can misresolve them', () => {
  it('clears the lens (deactivates + wipes computed maps) instead of leaving it pointed at a pre-reload federation', () => {
    // Reproduces the same georef-reload path as removeModel-compare-stale:
    // `clearAllModels()` directly, without `resetViewerState()` — the only
    // other place the lens gets deactivated.
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
    seedActiveLensState();

    useViewerStore.getState().clearAllModels();

    const after = useViewerStore.getState();
    console.log('activeLensId after clearAllModels:', after.activeLensId);
    console.log('lensHiddenIds after clearAllModels:', [...after.lensHiddenIds]);
    console.log('lensColorMap after clearAllModels:', [...after.lensColorMap.entries()]);

    assert.strictEqual(after.activeLensId, null, 'clearAllModels must deactivate the lens — no federation is left for it to describe');
    assert.strictEqual(after.lensHiddenIds.size, 0, 'lensHiddenIds must not survive with stale global ids');
    assert.strictEqual(after.lensColorMap.size, 0, 'lensColorMap must not survive with stale global ids');
    assert.strictEqual(after.lensAppliedColors, null);
    assert.strictEqual(after.lensAppliedHiddenIds.length, 0);
    assert.strictEqual(after.lensRuleEntityIds.size, 0);

    // Reload: offset space was reset by federationRegistry.clear() inside
    // clearAllModels, so the first model back gets offset 0 again — global id
    // 42 (previously A's lens-matched entity) would land on model C's own
    // live entity 42 if the lens state had survived.
    const newOffsetC = federationRegistry.registerModel('C', 50);
    assert.strictEqual(newOffsetC, 0, 'offset space is not burned across a full clear — confirms the hazard is real');
    useViewerStore.getState().addModel(model('C', newOffsetC, 50));

    const final = useViewerStore.getState();
    assert.strictEqual(final.activeLensId, null, 'reload must not resurrect a deactivated lens');
    assert.strictEqual(final.lensHiddenIds.size, 0, 'model C\'s own entity 7 (if it has one) must not be hidden by a stale lens claim');
  });

  it('negative control: removeModel (partial, no offset reuse) leaves the active lens untouched', () => {
    // No `federationRegistry.clear()` runs on a partial removal — offsets are
    // burned, never reused — so there is no collision hazard here, and the
    // lens state legitimately still describes the surviving model B. Proves
    // the clearAllModels fix above is not a blanket "any model change clears
    // the lens".
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
    seedActiveLensState();

    useViewerStore.getState().removeModel('A');

    const after = useViewerStore.getState();
    console.log('activeLensId after removeModel(A):', after.activeLensId);
    assert.strictEqual(after.activeLensId, 'lens-1', 'removing one model of a federation must not deactivate an active lens');
    assert.deepStrictEqual(after.lensHiddenIds, new Set([7, 1008]));
  });
});
