/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createPinboardSlice, type PinboardSlice } from './pinboardSlice.js';
import type { EntityRef } from '../types.js';

function createMockCrossSlice() {
  return {
    isolatedEntities: null as Set<number> | null,
    hiddenEntities: new Set<number>(),
    models: new Map<string, { idOffset: number }>([['legacy', { idOffset: 0 }]]),
    cameraCallbacks: { getViewpoint: () => null },
    sectionPlane: { axis: 'front' as const, position: 50, enabled: false, flipped: false },
    drawing2D: null,
    drawing2DDisplayOptions: { show3DOverlay: true, showHiddenLines: true },
    setDrawing2D: () => {},
    updateDrawing2DDisplayOptions: () => {},
    setActiveTool: () => {},
    clearEntitySelection: () => {},
    activeTool: 'select',
  };
}

describe('PinboardSlice', () => {
  let state: PinboardSlice & ReturnType<typeof createMockCrossSlice>;
  let setState: (partial: Partial<typeof state> | ((s: typeof state) => Partial<typeof state>)) => void;

  beforeEach(() => {
    const cross = createMockCrossSlice();
    setState = (partial) => {
      if (typeof partial === 'function') {
        const updates = partial(state);
        state = { ...state, ...updates };
      } else {
        state = { ...state, ...partial };
      }
    };

    state = {
      ...cross,
      // The test mock's cross-slice shape is slightly looser than the
      // real PinboardCrossSliceState (e.g. cameraCallbacks.getViewpoint
      // returns null only), so the typed StateCreator can't accept the
      // mock setState directly. Cast at the boundary — runtime shape
      // is correct, just structurally narrower than the prod type.
      ...createPinboardSlice(setState as any, (() => state) as any, cross as any),
    };
  });

  describe('setBasket / addToBasket / removeFromBasket isolation sync', () => {
    it('setBasket syncs pinboardEntities and isolatedEntities', () => {
      const refs: EntityRef[] = [
        { modelId: 'legacy', expressId: 100 },
        { modelId: 'legacy', expressId: 200 },
      ];
      state.setBasket(refs);

      assert.strictEqual(state.pinboardEntities.size, 2);
      assert.ok(state.pinboardEntities.has('legacy:100'));
      assert.ok(state.pinboardEntities.has('legacy:200'));
      assert.ok(state.isolatedEntities !== null);
      assert.strictEqual(state.isolatedEntities!.size, 2);
      assert.ok(state.isolatedEntities!.has(100));
      assert.ok(state.isolatedEntities!.has(200));
    });

    it('addToBasket adds to existing basket and updates isolation', () => {
      state.setBasket([{ modelId: 'legacy', expressId: 100 }]);
      state.addToBasket([{ modelId: 'legacy', expressId: 200 }]);

      assert.strictEqual(state.pinboardEntities.size, 2);
      assert.ok(state.isolatedEntities !== null);
      assert.strictEqual(state.isolatedEntities!.size, 2);
    });

    it('removeFromBasket removes and clears isolation when empty', () => {
      state.setBasket([{ modelId: 'legacy', expressId: 100 }]);
      state.removeFromBasket([{ modelId: 'legacy', expressId: 100 }]);

      assert.strictEqual(state.pinboardEntities.size, 0);
      assert.strictEqual(state.isolatedEntities, null);
    });

    it('addToBasket computes the offset-corrected global id for a non-legacy model, not the raw expressId', () => {
      // All other basket tests use a single 'legacy' model with idOffset 0,
      // where a global id and a local expressId are numerically identical —
      // a bug that used the raw expressId instead of the offset-corrected
      // global id would be invisible under that fixture. Use a federated
      // model with a non-zero offset so the two values visibly diverge.
      setState({
        models: new Map([
          ['legacy', { idOffset: 0 }],
          ['model-2', { idOffset: 1000 }],
        ]),
      });
      state.setBasket([{ modelId: 'legacy', expressId: 5 }]);
      state.addToBasket([{ modelId: 'model-2', expressId: 7 }]);

      assert.strictEqual(state.isolatedEntities!.size, 2);
      assert.ok(state.isolatedEntities!.has(5));
      assert.ok(state.isolatedEntities!.has(1007), 'expected offset-corrected global id 1007');
      assert.ok(!state.isolatedEntities!.has(7), 'must not use the raw (un-offset) expressId 7');
    });

    it('removeFromBasket removes the offset-corrected global id for a non-legacy model, not the raw expressId', () => {
      setState({
        models: new Map([
          ['legacy', { idOffset: 0 }],
          ['model-2', { idOffset: 1000 }],
        ]),
      });
      state.setBasket([
        { modelId: 'legacy', expressId: 5 },
        { modelId: 'model-2', expressId: 7 },
      ]);
      state.removeFromBasket([{ modelId: 'model-2', expressId: 7 }]);

      assert.strictEqual(state.pinboardEntities.size, 1);
      assert.ok(state.isolatedEntities !== null);
      assert.strictEqual(state.isolatedEntities!.size, 1);
      assert.ok(state.isolatedEntities!.has(5));
      assert.ok(!state.isolatedEntities!.has(1007), 'the removed entity global id must be gone');
    });

    it('removeFromBasket keeps a global id isolated when a second aliased ref still holds the basket', () => {
      // Two distinct EntityRefs can map to the SAME global id: any modelId
      // absent from `models` (an unregistered federated model, e.g. one that
      // failed to register before a basket restore) falls back to the raw
      // expressId, same as the 'legacy' sentinel — see toGlobalIdFromModels
      // in globalId.ts. 'legacy:100' and 'unregistered-model:100' therefore
      // both derive global id 100. Removing only ONE of them must not evict
      // 100 from isolatedEntities while the other still requires it.
      state.setBasket([
        { modelId: 'legacy', expressId: 100 },
        { modelId: 'unregistered-model', expressId: 100 },
      ]);
      assert.strictEqual(state.pinboardEntities.size, 2);
      assert.ok(state.isolatedEntities !== null);
      assert.strictEqual(state.isolatedEntities!.size, 1, 'both refs alias to global id 100');

      state.removeFromBasket([{ modelId: 'legacy', expressId: 100 }]);

      assert.strictEqual(state.pinboardEntities.size, 1, 'unregistered-model:100 is still pinned');
      assert.ok(state.isolatedEntities !== null, 'basket is non-empty, isolation must stay active');
      assert.ok(
        state.isolatedEntities!.has(100),
        'global id 100 is still required by the surviving unregistered-model:100 entry',
      );
    });

    // The two basket writers must stay symmetric about ids they did not
    // author (#4509 review). `addToBasket` seeds from the EXISTING
    // `isolatedEntities` when there is one, so an isolation installed by
    // another writer -- a restored BCF viewpoint, a lens rule, a search
    // isolate -- survives a pin. A `removeFromBasket` that recomputes purely
    // from the surviving basket would silently drop those same ids, so
    // pinning one element and unpinning another would quietly destroy the
    // viewpoint the user was working inside. Remove only what the removed
    // refs contributed AND nothing surviving still requires.
    it('removeFromBasket keeps isolation ids it did not author, as addToBasket does', () => {
      const FOREIGN = 5000; // e.g. installed by a restored BCF viewpoint
      state.setBasket([
        { modelId: 'legacy', expressId: 100 },
        { modelId: 'legacy', expressId: 200 },
      ]);
      // Another writer widens the isolation; addToBasket would preserve this.
      setState({ isolatedEntities: new Set([...state.isolatedEntities!, FOREIGN]) });

      state.addToBasket([{ modelId: 'legacy', expressId: 300 }]);
      assert.ok(
        state.isolatedEntities!.has(FOREIGN),
        'sanity: addToBasket preserves an isolation id it did not author',
      );

      state.removeFromBasket([{ modelId: 'legacy', expressId: 300 }]);

      assert.ok(
        state.isolatedEntities!.has(FOREIGN),
        'BUG: removeFromBasket discarded an isolation id it never authored',
      );
      assert.ok(state.isolatedEntities!.has(100), 'surviving basket entries stay isolated');
      assert.ok(state.isolatedEntities!.has(200), 'surviving basket entries stay isolated');
      assert.ok(!state.isolatedEntities!.has(300), 'the unpinned entity is no longer isolated');
    });

    // A ref that was never pinned has no basket claim on its global id: asking
    // to remove it must not evict an isolation entry another writer owns.
    it('removeFromBasket ignores refs that were not in the basket instead of evicting their isolation id', () => {
      const FOREIGN = 500; // isolated by a BCF viewpoint, never pinned
      state.setBasket([{ modelId: 'legacy', expressId: 100 }]);
      setState({ isolatedEntities: new Set([...state.isolatedEntities!, FOREIGN]) });

      state.removeFromBasket([{ modelId: 'legacy', expressId: FOREIGN }]);

      assert.ok(state.isolatedEntities!.has(FOREIGN), 'BUG: a never-pinned ref evicted an externally-owned isolation id');
      assert.ok(state.isolatedEntities!.has(100));
      assert.strictEqual(state.pinboardEntities.size, 1, 'the basket is unchanged');
    });
  });

  // #4527: the basket records which isolation ids it inserted and whether it
  // opened the channel, and judges ownership of the channel BY VALUE before it
  // narrows anything (lib/visibility/ownership.ts). The harness has no
  // invalidation middleware, so a foreign replacement is simulated by writing
  // the channel and nulling the record — exactly what the middleware does.
  describe('basket-owned isolation (#4527)', () => {
    const foreignReplace = (ids: number[]) => setState({ isolatedEntities: new Set(ids), basketVisibilityOwned: null });

    it('emptying the basket by removal keeps an isolation it only widened', () => {
      const FOREIGN = 500;
      setState({ isolatedEntities: new Set([FOREIGN]) }); // opened by someone else
      state.addToBasket([{ modelId: 'legacy', expressId: 100 }]);
      assert.ok(state.basketVisibilityOwned && !state.basketVisibilityOwned.seeded, 'the basket did not open the channel');

      state.removeFromBasket([{ modelId: 'legacy', expressId: 100 }]);

      assert.deepStrictEqual(state.isolatedEntities, new Set([FOREIGN]), 'the external isolation survives, not null');
      assert.strictEqual(state.basketVisibilityOwned, null);
    });

    it('emptying the basket by removal closes an isolation the basket opened', () => {
      assert.strictEqual(state.isolatedEntities, null);
      state.addToBasket([{ modelId: 'legacy', expressId: 100 }]);
      assert.ok(state.basketVisibilityOwned?.seeded);
      state.removeFromBasket([{ modelId: 'legacy', expressId: 100 }]);
      assert.strictEqual(state.isolatedEntities, null);
    });

    it('an id that was already isolated when pinned is not claimed and survives unpinning', () => {
      setState({ isolatedEntities: new Set([100]) });
      state.addToBasket([{ modelId: 'legacy', expressId: 100 }, { modelId: 'legacy', expressId: 200 }]);
      assert.deepStrictEqual(state.basketVisibilityOwned?.claims, new Set([200]));
      state.removeFromBasket([{ modelId: 'legacy', expressId: 100 }]);
      assert.ok(state.isolatedEntities!.has(100), '100 belonged to another writer');
      state.removeFromBasket([{ modelId: 'legacy', expressId: 200 }]);
      assert.deepStrictEqual(state.isolatedEntities, new Set([100]));
    });

    it('a foreign REPLACEMENT of the channel ends the basket claim: unpinning touches nothing', () => {
      state.setBasket([{ modelId: 'legacy', expressId: 100 }]);
      foreignReplace([100, 900]); // e.g. search isolates a set that happens to include 100
      state.removeFromBasket([{ modelId: 'legacy', expressId: 100 }]);
      assert.deepStrictEqual(state.isolatedEntities, new Set([100, 900]), "the search isolation is not the basket's");
      assert.strictEqual(state.pinboardEntities.size, 0);
    });

    it('a foreign subset replacement is not emptied either', () => {
      state.setBasket([{ modelId: 'legacy', expressId: 100 }, { modelId: 'legacy', expressId: 200 }]);
      foreignReplace([100]);
      state.removeFromBasket([{ modelId: 'legacy', expressId: 100 }]);
      assert.deepStrictEqual(state.isolatedEntities, new Set([100]));
    });

    it('after an external clearIsolation the surviving basket re-takes the channel and records it', () => {
      state.setBasket([{ modelId: 'legacy', expressId: 100 }, { modelId: 'legacy', expressId: 200 }]);
      setState({ isolatedEntities: null, basketVisibilityOwned: null }); // "hide active basket"
      state.removeFromBasket([{ modelId: 'legacy', expressId: 100 }]);
      assert.deepStrictEqual(state.isolatedEntities, new Set([200]));
      assert.deepStrictEqual(state.basketVisibilityOwned?.claims, new Set([200]));
      state.removeFromBasket([{ modelId: 'legacy', expressId: 200 }]);
      assert.strictEqual(state.isolatedEntities, null, 'the re-take opened the channel, so emptying closes it');
    });

    it('showPinboard records ownership so a later removal narrows', () => {
      state.setBasket([{ modelId: 'legacy', expressId: 100 }, { modelId: 'legacy', expressId: 200 }]);
      setState({ isolatedEntities: null, basketVisibilityOwned: null });
      state.showPinboard();
      assert.deepStrictEqual(state.basketVisibilityOwned?.ids, new Set([100, 200]));
      state.removeFromBasket([{ modelId: 'legacy', expressId: 200 }]);
      assert.deepStrictEqual(state.isolatedEntities, new Set([100]));
    });

    it('adding onto an empty-but-active foreign isolate and removing everything gives the empty Set back', () => {
      setState({ isolatedEntities: new Set() }); // a restored BCF viewpoint isolating nothing (#4509)
      state.addToBasket([{ modelId: 'legacy', expressId: 100 }]);
      assert.deepStrictEqual(state.basketVisibilityOwned?.claims, new Set([100]));
      assert.ok(!state.basketVisibilityOwned?.seeded);
      state.removeFromBasket([{ modelId: 'legacy', expressId: 100 }]);
      assert.deepStrictEqual(state.isolatedEntities, new Set(), 'active-but-empty, not null');
    });

    it('clearBasket closes an isolation the basket opened, keeps one it only widened, leaves one it lost', () => {
      state.setBasket([{ modelId: 'legacy', expressId: 100 }]);
      state.clearBasket();
      assert.strictEqual(state.isolatedEntities, null, 'opened by the basket: closed');

      setState({ isolatedEntities: new Set([500]) });
      state.addToBasket([{ modelId: 'legacy', expressId: 100 }]);
      state.clearBasket();
      assert.deepStrictEqual(state.isolatedEntities, new Set([500]), 'widened only: the remainder is handed back');

      state.setBasket([{ modelId: 'legacy', expressId: 100 }]);
      foreignReplace([100, 900]);
      state.clearBasket();
      assert.deepStrictEqual(state.isolatedEntities, new Set([100, 900]), "lost to another writer: not the basket's to close");
      assert.strictEqual(state.pinboardEntities.size, 0);
    });

    it('adding with the channel closed and a pre-existing basket claims the union', () => {
      state.setBasket([{ modelId: 'legacy', expressId: 100 }]);
      setState({ isolatedEntities: null, basketVisibilityOwned: null });
      state.addToBasket([{ modelId: 'legacy', expressId: 200 }]);
      assert.deepStrictEqual(state.isolatedEntities, new Set([100, 200]));
      assert.deepStrictEqual(state.basketVisibilityOwned?.claims, new Set([100, 200]));
      assert.ok(state.basketVisibilityOwned?.seeded);
    });
  });

  describe('saveCurrentBasketView', () => {
    it('creates view with unique id and sets activeBasketViewId', () => {
      state.setBasket([{ modelId: 'legacy', expressId: 100 }]);
      const id = state.saveCurrentBasketView();

      assert.ok(id !== null);
      assert.strictEqual(state.basketViews.length, 1);
      assert.strictEqual(state.activeBasketViewId, id);
      assert.strictEqual(state.basketViews[0].entityRefs.length, 1);
    });

    it('auto-increments view name', () => {
      state.setBasket([{ modelId: 'legacy', expressId: 100 }]);
      state.saveCurrentBasketView();
      state.saveCurrentBasketView();

      assert.strictEqual(state.basketViews.length, 2);
      assert.strictEqual(state.basketViews[0].name, 'Basket 1');
      assert.strictEqual(state.basketViews[1].name, 'Basket 2');
    });

    it('returns null when basket is empty', () => {
      const id = state.saveCurrentBasketView();
      assert.strictEqual(id, null);
    });

    it('captures section plane but not 2D drawing payload', () => {
      state.setBasket([{ modelId: 'legacy', expressId: 100 }]);
      state.activeTool = 'section';
      state.sectionPlane = { axis: 'front', position: 42, enabled: true, flipped: false };
      state.drawing2D = {
        lines: [{ line: { start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }, visibility: 'visible', category: 'solid' }],
        cutPolygons: [],
      } as unknown as typeof state.drawing2D;

      const id = state.saveCurrentBasketView();
      assert.ok(id !== null);
      const saved = state.basketViews[0];
      assert.ok(saved.section !== null);
      assert.strictEqual(saved.section!.plane.enabled, true);
      assert.strictEqual(saved.section!.drawing2D, null);
    });
  });

  describe('restoreBasketEntities', () => {
    it('restores basket and isolation state only', () => {
      state.restoreBasketEntities(['legacy:100', 'legacy:200'], 'view-1');

      assert.strictEqual(state.pinboardEntities.size, 2);
      assert.ok(state.pinboardEntities.has('legacy:100'));
      assert.ok(state.pinboardEntities.has('legacy:200'));
      assert.strictEqual(state.activeBasketViewId, 'view-1');
      assert.ok(state.isolatedEntities !== null);
      assert.strictEqual(state.isolatedEntities!.size, 2);
    });

    it('handles empty entityRefs', () => {
      state.restoreBasketEntities([], 'view-empty');

      assert.strictEqual(state.pinboardEntities.size, 0);
      assert.strictEqual(state.isolatedEntities, null);
      assert.strictEqual(state.activeBasketViewId, 'view-empty');
    });
  });

  describe('removeBasketView', () => {
    it('removes the view and clears activeBasketViewId when it was the active one', () => {
      state.setBasket([{ modelId: 'legacy', expressId: 100 }]);
      const id = state.saveCurrentBasketView();
      assert.strictEqual(state.activeBasketViewId, id);

      state.removeBasketView(id!);

      assert.strictEqual(state.basketViews.length, 0);
      assert.strictEqual(state.activeBasketViewId, null);
    });

    it('leaves activeBasketViewId untouched when removing a DIFFERENT (non-active) view', () => {
      // Non-default state: two saved views, and the active one is NOT the
      // one being removed. A mutant that unconditionally nulls
      // activeBasketViewId on every removal passes any test that only
      // removes the active view — this pins the other direction.
      state.setBasket([{ modelId: 'legacy', expressId: 100 }]);
      const firstId = state.saveCurrentBasketView();
      state.setBasket([{ modelId: 'legacy', expressId: 200 }]);
      const secondId = state.saveCurrentBasketView();
      assert.strictEqual(state.activeBasketViewId, secondId);

      state.removeBasketView(firstId!);

      assert.strictEqual(state.basketViews.length, 1);
      assert.strictEqual(state.basketViews[0].id, secondId);
      assert.strictEqual(state.activeBasketViewId, secondId, 'removing an inactive view must not clear the active one');
    });

    it('removing an unknown id is a no-op for activeBasketViewId', () => {
      state.setBasket([{ modelId: 'legacy', expressId: 100 }]);
      const id = state.saveCurrentBasketView();

      state.removeBasketView('does-not-exist');

      assert.strictEqual(state.basketViews.length, 1);
      assert.strictEqual(state.activeBasketViewId, id);
    });
  });

  describe('clearBasket', () => {
    it('resets activeBasketViewId', () => {
      state.setBasket([{ modelId: 'legacy', expressId: 100 }]);
      state.saveCurrentBasketView();
      assert.ok(state.activeBasketViewId !== null);

      state.clearBasket();
      assert.strictEqual(state.activeBasketViewId, null);
      assert.strictEqual(state.pinboardEntities.size, 0);
      assert.strictEqual(state.isolatedEntities, null);
    });
  });
});
