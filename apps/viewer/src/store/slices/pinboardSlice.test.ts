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
