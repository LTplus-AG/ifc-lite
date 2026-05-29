/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createVisibilitySlice, type VisibilitySlice } from './visibilitySlice.js';
import { getPersistedTypeVisibility } from '../constants.js';

describe('VisibilitySlice', () => {
  let state: VisibilitySlice;
  let setState: (partial: Partial<VisibilitySlice> | ((state: VisibilitySlice) => Partial<VisibilitySlice>)) => void;

  beforeEach(() => {
    setState = (partial) => {
      if (typeof partial === 'function') {
        const updates = partial(state);
        state = { ...state, ...updates };
      } else {
        state = { ...state, ...partial };
      }
    };

    state = createVisibilitySlice(setState, () => state, {} as any);
  });

  describe('initial state', () => {
    it('should have empty hiddenEntitiesByModel', () => {
      assert.strictEqual(state.hiddenEntitiesByModel.size, 0);
    });

    it('should have empty isolatedEntitiesByModel', () => {
      assert.strictEqual(state.isolatedEntitiesByModel.size, 0);
    });

    it('should initialise type visibility from persisted preferences', () => {
      const persisted = getPersistedTypeVisibility();
      assert.strictEqual(state.typeVisibility.spaces, persisted.spaces);
      assert.strictEqual(state.typeVisibility.openings, persisted.openings);
      assert.strictEqual(state.typeVisibility.site, persisted.site);
      assert.strictEqual(state.typeVisibility.ifcAnnotations, persisted.ifcAnnotations);
      assert.strictEqual(state.typeVisibility.ifcGrid, persisted.ifcGrid);
    });
  });

  describe('multi-model visibility: hideEntityInModel', () => {
    it('should hide entity in specific model', () => {
      state.hideEntityInModel('model-1', 123);

      const hidden = state.hiddenEntitiesByModel.get('model-1');
      assert.ok(hidden);
      assert.ok(hidden.has(123));
    });

    it('should create new set for model if not exists', () => {
      state.hideEntityInModel('model-1', 100);
      state.hideEntityInModel('model-1', 200);

      const hidden = state.hiddenEntitiesByModel.get('model-1');
      assert.strictEqual(hidden?.size, 2);
    });

    it('should keep models separate', () => {
      state.hideEntityInModel('model-1', 100);
      state.hideEntityInModel('model-2', 200);

      assert.strictEqual(state.hiddenEntitiesByModel.get('model-1')?.size, 1);
      assert.strictEqual(state.hiddenEntitiesByModel.get('model-2')?.size, 1);
      assert.ok(state.hiddenEntitiesByModel.get('model-1')?.has(100));
      assert.ok(state.hiddenEntitiesByModel.get('model-2')?.has(200));
    });
  });

  describe('multi-model visibility: hideEntitiesInModel', () => {
    it('should hide multiple entities', () => {
      state.hideEntitiesInModel('model-1', [100, 200, 300]);

      const hidden = state.hiddenEntitiesByModel.get('model-1');
      assert.strictEqual(hidden?.size, 3);
      assert.ok(hidden?.has(100));
      assert.ok(hidden?.has(200));
      assert.ok(hidden?.has(300));
    });
  });

  describe('multi-model visibility: showEntityInModel', () => {
    it('should show hidden entity', () => {
      state.hideEntityInModel('model-1', 123);
      state.showEntityInModel('model-1', 123);

      const hidden = state.hiddenEntitiesByModel.get('model-1');
      // Set should be removed when empty
      assert.strictEqual(hidden, undefined);
    });

    it('should do nothing for non-hidden entity', () => {
      state.showEntityInModel('model-1', 123);
      // Should not throw, just do nothing
      assert.strictEqual(state.hiddenEntitiesByModel.size, 0);
    });

    it('should remove model from map when all entities shown', () => {
      state.hideEntityInModel('model-1', 100);
      state.hideEntityInModel('model-1', 200);
      state.showEntityInModel('model-1', 100);
      state.showEntityInModel('model-1', 200);

      assert.ok(!state.hiddenEntitiesByModel.has('model-1'));
    });
  });

  describe('multi-model visibility: showEntitiesInModel', () => {
    it('should show multiple entities', () => {
      state.hideEntitiesInModel('model-1', [100, 200, 300]);
      state.showEntitiesInModel('model-1', [100, 200]);

      const hidden = state.hiddenEntitiesByModel.get('model-1');
      assert.strictEqual(hidden?.size, 1);
      assert.ok(hidden?.has(300));
    });
  });

  describe('multi-model visibility: toggleEntityVisibilityInModel', () => {
    it('should hide visible entity', () => {
      state.toggleEntityVisibilityInModel('model-1', 123);

      const hidden = state.hiddenEntitiesByModel.get('model-1');
      assert.ok(hidden?.has(123));
    });

    it('should show hidden entity', () => {
      state.hideEntityInModel('model-1', 123);
      state.toggleEntityVisibilityInModel('model-1', 123);

      // Set should be removed when empty
      assert.ok(!state.hiddenEntitiesByModel.has('model-1'));
    });
  });

  describe('multi-model visibility: isEntityVisibleInModel', () => {
    it('should return true for visible entity', () => {
      assert.strictEqual(state.isEntityVisibleInModel('model-1', 123), true);
    });

    it('should return false for hidden entity', () => {
      state.hideEntityInModel('model-1', 123);
      assert.strictEqual(state.isEntityVisibleInModel('model-1', 123), false);
    });

    it('should distinguish between models', () => {
      state.hideEntityInModel('model-1', 123);

      assert.strictEqual(state.isEntityVisibleInModel('model-1', 123), false);
      assert.strictEqual(state.isEntityVisibleInModel('model-2', 123), true);
    });
  });

  describe('multi-model visibility: getHiddenEntitiesForModel', () => {
    it('should return hidden entities for model', () => {
      state.hideEntitiesInModel('model-1', [100, 200, 300]);

      const hidden = state.getHiddenEntitiesForModel('model-1');
      assert.strictEqual(hidden.size, 3);
      assert.ok(hidden.has(100));
      assert.ok(hidden.has(200));
      assert.ok(hidden.has(300));
    });

    it('should return empty set for model with no hidden entities', () => {
      const hidden = state.getHiddenEntitiesForModel('non-existent');
      assert.strictEqual(hidden.size, 0);
    });
  });

  describe('multi-model visibility: clearModelVisibility', () => {
    it('should clear visibility state for model', () => {
      state.hideEntitiesInModel('model-1', [100, 200]);

      state.clearModelVisibility('model-1');

      assert.ok(!state.hiddenEntitiesByModel.has('model-1'));
      assert.ok(!state.isolatedEntitiesByModel.has('model-1'));
    });

    it('should not affect other models', () => {
      state.hideEntitiesInModel('model-1', [100]);
      state.hideEntitiesInModel('model-2', [200]);

      state.clearModelVisibility('model-1');

      assert.ok(!state.hiddenEntitiesByModel.has('model-1'));
      assert.ok(state.hiddenEntitiesByModel.has('model-2'));
    });
  });

  describe('multi-model visibility: showAllInAllModels', () => {
    it('should clear all visibility state', () => {
      // Set up some state
      state.hideEntitiesInModel('model-1', [100, 200]);
      state.hideEntitiesInModel('model-2', [300, 400]);
      state.hideEntity(500); // Legacy

      state.showAllInAllModels();

      assert.strictEqual(state.hiddenEntitiesByModel.size, 0);
      assert.strictEqual(state.isolatedEntitiesByModel.size, 0);
      assert.strictEqual(state.hiddenEntities.size, 0);
      assert.strictEqual(state.isolatedEntities, null);
    });
  });

  describe('legacy visibility: hideEntity', () => {
    it('should hide entity', () => {
      state.hideEntity(123);
      assert.ok(state.hiddenEntities.has(123));
    });
  });

  describe('legacy visibility: showEntity', () => {
    it('should show hidden entity', () => {
      state.hideEntity(123);
      state.showEntity(123);
      assert.ok(!state.hiddenEntities.has(123));
    });
  });

  describe('legacy visibility: toggleEntityVisibility', () => {
    it('should toggle visibility', () => {
      state.toggleEntityVisibility(123);
      assert.ok(state.hiddenEntities.has(123));

      state.toggleEntityVisibility(123);
      assert.ok(!state.hiddenEntities.has(123));
    });
  });

  describe('legacy visibility: isolateEntity', () => {
    it('should isolate single entity', () => {
      state.isolateEntity(123);
      assert.ok(state.isolatedEntities?.has(123));
      assert.strictEqual(state.isolatedEntities?.size, 1);
    });

    it('should toggle isolation off when re-isolating same entity', () => {
      state.isolateEntity(123);
      state.isolateEntity(123);
      assert.strictEqual(state.isolatedEntities, null);
    });
  });

  describe('legacy visibility: clearIsolation', () => {
    it('should clear isolation', () => {
      state.isolateEntity(123);
      state.clearIsolation();
      assert.strictEqual(state.isolatedEntities, null);
    });
  });

  describe('legacy visibility: showAll', () => {
    it('should clear all visibility state', () => {
      state.hideEntity(123);
      state.isolateEntity(456);

      state.showAll();

      assert.strictEqual(state.hiddenEntities.size, 0);
      assert.strictEqual(state.isolatedEntities, null);
    });
  });

  describe('legacy visibility: isEntityVisible', () => {
    it('should return true for visible entity', () => {
      assert.strictEqual(state.isEntityVisible(123), true);
    });

    it('should return false for hidden entity', () => {
      state.hideEntity(123);
      assert.strictEqual(state.isEntityVisible(123), false);
    });

    it('should return false for non-isolated entity when isolation active', () => {
      state.isolateEntity(100);
      assert.strictEqual(state.isEntityVisible(100), true);
      assert.strictEqual(state.isEntityVisible(200), false);
    });
  });

  describe('type visibility: toggleTypeVisibility', () => {
    it('should toggle spaces visibility', () => {
      const initial = state.typeVisibility.spaces;
      state.toggleTypeVisibility('spaces');
      assert.strictEqual(state.typeVisibility.spaces, !initial);
    });

    it('should toggle openings visibility', () => {
      const initial = state.typeVisibility.openings;
      state.toggleTypeVisibility('openings');
      assert.strictEqual(state.typeVisibility.openings, !initial);
    });

    it('should toggle site visibility', () => {
      const initial = state.typeVisibility.site;
      state.toggleTypeVisibility('site');
      assert.strictEqual(state.typeVisibility.site, !initial);
    });

    it('should toggle ifcAnnotations visibility', () => {
      const initial = state.typeVisibility.ifcAnnotations;
      state.toggleTypeVisibility('ifcAnnotations');
      assert.strictEqual(state.typeVisibility.ifcAnnotations, !initial);
    });
  });
});
