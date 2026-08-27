/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { useViewerStore } from './index.js';
import { viewerTeardown } from './teardown-registry.js';
import { modelRemovedScope } from './teardown-scope.js';
import type { FederatedModel } from './types.js';

function model(id: string, idOffset: number, maxExpressId: number): FederatedModel {
  return { id, name: id, visible: true, idOffset, maxExpressId } as unknown as FederatedModel;
}

/**
 * `syncSourceModel` runs the `model-removed` composition a SECOND time, right
 * after `removeModel` has already run it, and the comment at the call site
 * justifies that by claiming every contribution returns `{}` once nothing of
 * its own moved. Nothing asserted it.
 *
 * The claim is load-bearing rather than tidy. A contribution that rebuilds an
 * equal-but-new `Map` or `Set` instead of returning `{}` defeats
 * `composeTeardown`'s `Object.is` filter, so the second pass writes a fresh
 * reference for a value that did not change. That re-renders every subscriber
 * of that key, and for `isolatedEntities` / `ghostExceptEntities` it puts the
 * write through `withVisibilityOwnershipInvalidation` a second time, dropping
 * ownership records that the first pass had already settled.
 *
 * Neither symptom is a failing assertion anywhere else: the state ends up
 * value-equal either way, so every existing teardown test stays green while
 * the churn happens. This test reads the PATCH rather than the state, which is
 * the only place the difference is visible.
 */
describe('the model-removed teardown scope is idempotent', () => {
  it('re-running the same scope after removeModel produces an empty patch, which is what lets syncSourceModel run it a second time (see its call site)', () => {
    useViewerStore.setState({
      models: new Map([
        ['A', model('A', 0, 100)],
        ['B', model('B', 1000, 1100)],
      ]),
      activeModelId: 'A',
      selectedEntityIds: new Set([42, 1005]),
      selectedEntityId: 42,
      hiddenEntities: new Set([43, 1006]),
      selectedStoreys: new Set([44]),
      isolatedEntities: new Set([45, 1007]),
      hiddenEntitiesByModel: new Map([['A', new Set([43])], ['B', new Set([1006])]]),
      isolatedEntitiesByModel: new Map([['A', new Set([45])], ['B', new Set([1007])]]),
    });
    useViewerStore.getState().setBasket([
      { modelId: 'A', expressId: 42 },
      { modelId: 'B', expressId: 5 },
    ]);

    // Guard against a vacuous pass: the composition must have real work to do
    // on this state, or an empty second patch would prove nothing at all.
    const before = useViewerStore.getState();
    const firstPatch = viewerTeardown(modelRemovedScope(before, 'A'), before);
    assert.ok(
      Object.keys(firstPatch).length > 0,
      'the fixture must give the composition something to clear, or this test cannot fail',
    );

    useViewerStore.getState().removeModel('A');

    // The identical scope. `modelRemovedScope` filters the removed model out of
    // the survivor set by id, so it builds the same `isStale` before and after
    // the model leaves `models` — this is the scope `removeModel` just applied,
    // not a weaker one.
    const after = useViewerStore.getState();
    const secondPatch = viewerTeardown(modelRemovedScope(after, 'A'), after);

    assert.deepStrictEqual(
      Object.keys(secondPatch).sort(),
      [],
      'a second run of the same scope must write nothing: any key here is a contribution rebuilding an equal-but-new value instead of returning {}',
    );
  });

  it('the STRICTER scope syncSourceModel actually dispatches writes only what the first pass could not see', () => {
    // The case above re-runs the scope `removeModel` used. Production does not:
    // `syncSourceModel` passes the just-loaded replacement as `notYetASurvivor`,
    // so ids inside the replacement's fresh range become stale on the second
    // pass and only then. Without this, a regression in how `notYetASurvivor`
    // interacts with the per-slice gates would leave the file green.
    useViewerStore.setState({
      // Reset every channel this case reads. The test above leaves
      // selectedStoreys / hiddenEntitiesByModel / isolatedEntitiesByModel /
      // pinboardEntities populated, and inheriting them made the patches this
      // asserts on depend on file order.
      selectedStoreys: new Set<number>(),
      hiddenEntitiesByModel: new Map(),
      isolatedEntitiesByModel: new Map(),
      pinboardEntities: new Set<string>(),
      hierarchyBasketSelection: new Set<string>(),
      selectedEntities: [],
      selectedEntitiesSet: new Set<string>(),
      selectedEntity: null,
      activeStorey: null,
      selectedModelId: null,
      models: new Map([
        ['old', model('old', 5000, 5100)],
        ['repl', model('repl', 0, 100)],
        ['B', model('B', 1000, 1100)],
      ]),
      activeModelId: 'repl',
      // 42 lands inside the REPLACEMENT's fresh range, so `removeModel`'s scope
      // (which counts `repl` as a survivor) keeps it and the stricter one drops
      // it. 1005 belongs to B and must survive both.
      selectedEntityIds: new Set([42, 1005]),
      hiddenEntities: new Set([42, 1005]),
      isolatedEntities: null,
      ghostExceptEntities: null,
    });

    const before = useViewerStore.getState();
    const lenient = viewerTeardown(modelRemovedScope(before, 'old'), before);

    const stricter = viewerTeardown(modelRemovedScope(before, 'old', 'repl'), before);

    // The whole reason both runs exist: the stricter pass must see something the
    // lenient one did not. If these ever match, `notYetASurvivor` has stopped
    // discriminating and the resync's second pass is dead weight.
    assert.ok(
      (stricter.selectedEntityIds as Set<number> | undefined)?.has(42) === false,
      'the stricter scope must drop an id inside the replacement\'s fresh range',
    );
    // Measured, not hedged: the lenient scope finds nothing of selection's
    // stale, so selectionSlice returns {} and the key is absent entirely. An
    // earlier version of this allowed `undefined || has(42)`, which passed
    // through the undefined branch and never exercised the path it named.
    assert.ok(
      !('selectedEntityIds' in lenient),
      'the lenient scope must not touch selectedEntityIds at all: 42 is inside the ' +
        'replacement range and 1005 belongs to a survivor, so nothing of selection is stale. ' +
        'If this key appears, the two scopes no longer differ and one run is redundant.',
    );
    assert.ok(
      (stricter.selectedEntityIds as Set<number>).has(1005),
      'an id owned by a surviving model must survive the stricter pass too',
    );
  });
});
