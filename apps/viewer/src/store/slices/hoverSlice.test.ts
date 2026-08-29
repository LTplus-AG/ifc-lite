/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { hoverTeardown } from './hoverSlice.js';
import { modelRemovedScope } from '../teardown-scope.js';
import type { FederatedModel } from '../types.js';

/**
 * `hoverSlice`'s `model-removed` arm must clear a hover/context-menu entity
 * that named the removed model, the same way `selectionSlice.teardown.ts`'s
 * global-id half does (its own doc explains why: "a global id is 'stale'
 * once no SURVIVING model's parse range or overlay owns it").
 *
 * `hoverState.entityId` / `contextMenu.entityId` are federation GLOBAL ids
 * (`store/types.ts`: `entityId: number | null`, no `modelId` alongside it) —
 * exactly the shape `hoverSlice.ts`'s own session-reset doc comment warns
 * about: "ids are reused across files, so a hover tooltip or an open context
 * menu surviving a swap describes an unrelated element of the incoming one."
 * That warning covers `session-reset`; `model-removed` (one model dropped out
 * of a live federation, the rest staying loaded) is the same hazard and was
 * left `notApplicable`.
 */
describe('hoverTeardown — model-removed', () => {
  const model = (id: string, idOffset: number, maxExpressId: number) =>
    ({ id, name: id, visible: true, idOffset, maxExpressId }) as unknown as FederatedModel;

  it('clears a hovered entity and an open context menu that named the removed model', () => {
    // A: global ids [0, 100]. B survives with a disjoint range [1000, 1100].
    const models = new Map([['A', model('A', 0, 100)], ['B', model('B', 1000, 1100)]]);
    const state = {
      models,
      hoverState: { entityId: 42, screenX: 10, screenY: 20 },
      contextMenu: { isOpen: true, entityId: 42, screenX: 10, screenY: 20 },
    } as unknown as Parameters<typeof modelRemovedScope>[0];

    const scope = modelRemovedScope(state, 'A');
    assert.equal(scope.isStale(42), true, 'global id 42 belongs to the removed model A; no survivor owns it');

    const patch = hoverTeardown.teardown(scope, state);

    assert.deepStrictEqual(
      patch.hoverState,
      { entityId: null, screenX: 0, screenY: 0 },
      'a hover tooltip pointing at the removed model must be cleared, not left naming a stale (and reusable) global id',
    );
    assert.deepStrictEqual(
      patch.contextMenu,
      { isOpen: false, entityId: null, screenX: 0, screenY: 0 },
      'an open context menu for the removed model must close, not stay open over an id the incoming model can reuse',
    );
  });

  it('leaves a hover/context menu naming a SURVIVING model untouched', () => {
    const models = new Map([['A', model('A', 0, 100)], ['B', model('B', 1000, 1100)]]);
    const state = {
      models,
      hoverState: { entityId: 1005, screenX: 5, screenY: 6 },
      contextMenu: { isOpen: true, entityId: 1005, screenX: 5, screenY: 6 },
    } as unknown as Parameters<typeof modelRemovedScope>[0];

    const scope = modelRemovedScope(state, 'A');
    assert.equal(scope.isStale(1005), false, 'global id 1005 belongs to surviving model B');

    const patch = hoverTeardown.teardown(scope, state);

    assert.equal(patch.hoverState, undefined, 'a hover naming a surviving model must not be rewritten');
    assert.equal(patch.contextMenu, undefined, 'a context menu naming a surviving model must not be rewritten');
  });
});

/**
 * `all-models-cleared` has no `isStale` predicate to ask (no survivor is
 * left), so — like `selectionSlice.teardown.ts`'s equivalent arm — it must
 * clear unconditionally rather than defer to a check it cannot make. Several
 * `clearAllModels()` call sites (`GeoreferencingPanel.tsx`'s
 * `reloadModelsForAlignment`, a federation rebuild in `useFileCommands.tsx`)
 * do not also call `resetViewerState()`, so this arm is the only teardown
 * this scope gets.
 */
describe('hoverTeardown — all-models-cleared', () => {
  it('clears a hovered entity and an open context menu unconditionally', () => {
    const state = {
      hoverState: { entityId: 7, screenX: 1, screenY: 2 },
      contextMenu: { isOpen: true, entityId: 7, screenX: 1, screenY: 2 },
    } as unknown as Parameters<typeof hoverTeardown.teardown>[1];

    const patch = hoverTeardown.teardown({ kind: 'all-models-cleared' }, state);

    assert.deepStrictEqual(patch.hoverState, { entityId: null, screenX: 0, screenY: 0 });
    assert.deepStrictEqual(patch.contextMenu, { isOpen: false, entityId: null, screenX: 0, screenY: 0 });
  });
});
