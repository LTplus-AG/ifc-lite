/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { useViewerStore } from './index.js';
import type { FederatedModel } from './types.js';

function model(id: string, idOffset: number, maxExpressId: number): FederatedModel {
  return { id, name: id, visible: true, idOffset, maxExpressId } as unknown as FederatedModel;
}

describe('removeModel purges pinboard basket state pointing at a removed model', () => {
  it('drops the removed model\'s ref from pinboardEntities, so a later "isolate basket" click cannot leak an unscaled, collision-prone id', () => {
    useViewerStore.setState({
      models: new Map([
        ['A', model('A', 0, 100)],
        ['B', model('B', 1000, 1100)],
      ]),
      activeModelId: 'A',
    });

    // Basket the removed model's entity 42, plus a surviving entity from B.
    useViewerStore.getState().setBasket([
      { modelId: 'A', expressId: 42 },
      { modelId: 'B', expressId: 5 },
    ]);

    useViewerStore.getState().removeModel('A');

    const afterRemove = useViewerStore.getState();
    console.log('pinboardEntities after removeModel:', [...afterRemove.pinboardEntities]);
    assert.ok(
      !afterRemove.pinboardEntities.has('A:42'),
      'pinboardEntities must not contain a ref into the removed model',
    );

    // Simulate the user re-isolating the basket after removal (the
    // "Isolate" button in BasketPresentationDock -> showPinboard()). This
    // ALWAYS fully recomputes isolatedEntities from pinboardEntities via
    // basketToGlobalIds -> toGlobalIdForRef -> toGlobalIdFromModels, which
    // falls back to the RAW, un-offset expressId for any ref whose modelId
    // is no longer in `models`. Before the fix, pinboardEntities still held
    // "A:42", and showPinboard() would have isolated bare id 42 -- which
    // sits inside surviving model A-replacement-free ranges (any model with
    // idOffset 0) and can silently co-isolate an entity the user never
    // selected. With pinboardEntities purged, this cannot happen.
    useViewerStore.getState().showPinboard();

    const after = useViewerStore.getState();
    console.log('isolatedEntities after showPinboard:', after.isolatedEntities && [...after.isolatedEntities]);
    assert.ok(
      !after.isolatedEntities?.has(42),
      'a stale pinboard ref into the removed model must not resurface as an unscaled, collision-prone raw id 42',
    );
    assert.deepStrictEqual(
      after.isolatedEntities,
      new Set([1005]),
      'only the surviving basket entry (B:5 -> global id 1005) should be isolated',
    );
  });
});
