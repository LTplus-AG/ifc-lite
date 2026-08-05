/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createSelectionSlice, type SelectionSlice } from './selectionSlice.js';
import type { EntityRef } from '../types.js';

describe('SelectionSlice', () => {
  let state: SelectionSlice;
  let setState: (partial: Partial<SelectionSlice> | ((state: SelectionSlice) => Partial<SelectionSlice>)) => void;

  beforeEach(() => {
    setState = (partial) => {
      if (typeof partial === 'function') {
        const updates = partial(state);
        state = { ...state, ...updates };
      } else {
        state = { ...state, ...partial };
      }
    };

    state = createSelectionSlice(setState, () => state, {} as any);
  });

  describe('multi-model selection: setSelectedEntity', () => {
    it('should NOT update selectedEntityId (caller must use setSelectedEntityId for global ID)', () => {
      // NOTE: selectedEntityId holds the GLOBAL ID for renderer highlighting,
      // while selectedEntity.expressId holds the ORIGINAL express ID for property lookup.
      // The caller should use setSelectedEntityId(globalId) separately.
      const ref: EntityRef = { modelId: 'model-1', expressId: 456 };
      state.setSelectedEntity(ref);

      // selectedEntityId should remain null - caller must set it separately with globalId
      assert.strictEqual(state.selectedEntityId, null);
    });
  });

  describe('multi-model selection: addEntityToSelection', () => {
    it('should add entity to selection set', () => {
      const ref: EntityRef = { modelId: 'model-1', expressId: 123 };
      state.addEntityToSelection(ref);

      assert.strictEqual(state.selectedEntitiesSet.size, 1);
      assert.ok(state.selectedEntitiesSet.has('model-1:123'));
    });

    it('should update primary selection', () => {
      const ref: EntityRef = { modelId: 'model-1', expressId: 123 };
      state.addEntityToSelection(ref);

      assert.deepStrictEqual(state.selectedEntity, ref);
    });

    it('should allow multiple entities from different models', () => {
      const ref1: EntityRef = { modelId: 'model-1', expressId: 123 };
      const ref2: EntityRef = { modelId: 'model-2', expressId: 456 };

      state.addEntityToSelection(ref1);
      state.addEntityToSelection(ref2);

      assert.strictEqual(state.selectedEntitiesSet.size, 2);
      assert.ok(state.selectedEntitiesSet.has('model-1:123'));
      assert.ok(state.selectedEntitiesSet.has('model-2:456'));
    });

    it('should allow multiple entities from same model', () => {
      const ref1: EntityRef = { modelId: 'model-1', expressId: 100 };
      const ref2: EntityRef = { modelId: 'model-1', expressId: 200 };

      state.addEntityToSelection(ref1);
      state.addEntityToSelection(ref2);

      assert.strictEqual(state.selectedEntitiesSet.size, 2);
    });
  });

  describe('multi-model selection: addEntitiesToSelection (batch)', () => {
    it('should add every ref in one set call', () => {
      const refs: EntityRef[] = [
        { modelId: 'model-1', expressId: 1 },
        { modelId: 'model-1', expressId: 2 },
        { modelId: 'model-2', expressId: 3 },
      ];
      state.addEntitiesToSelection(refs);
      assert.strictEqual(state.selectedEntitiesSet.size, 3);
    });

    it('should set primary selection to the LAST ref (matches single-add convention)', () => {
      const refs: EntityRef[] = [
        { modelId: 'model-1', expressId: 1 },
        { modelId: 'model-2', expressId: 99 },
      ];
      state.addEntitiesToSelection(refs);
      assert.deepStrictEqual(state.selectedEntity, { modelId: 'model-2', expressId: 99 });
    });

    it('should be a no-op for empty input', () => {
      const before = state.selectedEntitiesSet;
      state.addEntitiesToSelection([]);
      assert.strictEqual(state.selectedEntitiesSet, before, 'state ref unchanged');
    });

    it('should compose with prior single-adds without losing entries', () => {
      const ref0: EntityRef = { modelId: 'model-1', expressId: 0 };
      state.addEntityToSelection(ref0);
      state.addEntitiesToSelection([
        { modelId: 'model-1', expressId: 1 },
        { modelId: 'model-1', expressId: 2 },
      ]);
      assert.strictEqual(state.selectedEntitiesSet.size, 3);
    });

    it('should dedupe overlapping refs without changing the set size beyond the union', () => {
      state.addEntityToSelection({ modelId: 'm', expressId: 7 });
      state.addEntitiesToSelection([
        { modelId: 'm', expressId: 7 }, // duplicate
        { modelId: 'm', expressId: 8 },
      ]);
      assert.strictEqual(state.selectedEntitiesSet.size, 2);
    });
  });

  describe('multi-model selection: removeEntityFromSelection', () => {
    it('should remove entity from selection set', () => {
      const ref: EntityRef = { modelId: 'model-1', expressId: 123 };
      state.addEntityToSelection(ref);
      state.removeEntityFromSelection(ref);

      assert.strictEqual(state.selectedEntitiesSet.size, 0);
    });

    it('should update primary selection when removing primary', () => {
      const ref1: EntityRef = { modelId: 'model-1', expressId: 123 };
      const ref2: EntityRef = { modelId: 'model-2', expressId: 456 };

      state.addEntityToSelection(ref1);
      state.addEntityToSelection(ref2);
      state.removeEntityFromSelection(ref2);

      // Primary should update to remaining entity
      assert.strictEqual(state.selectedEntitiesSet.size, 1);
      assert.ok(state.selectedEntitiesSet.has('model-1:123'));
    });

    it('should clear primary when removing last entity', () => {
      const ref: EntityRef = { modelId: 'model-1', expressId: 123 };
      state.addEntityToSelection(ref);
      state.removeEntityFromSelection(ref);

      assert.strictEqual(state.selectedEntity, null);
      assert.strictEqual(state.selectedEntityId, null);
    });
  });

  describe('multi-model selection: toggleEntitySelection', () => {
    it('should add entity if not selected', () => {
      const ref: EntityRef = { modelId: 'model-1', expressId: 123 };
      state.toggleEntitySelection(ref);

      assert.strictEqual(state.selectedEntitiesSet.size, 1);
      assert.ok(state.selectedEntitiesSet.has('model-1:123'));
    });

    it('should remove entity if already selected', () => {
      const ref: EntityRef = { modelId: 'model-1', expressId: 123 };
      state.addEntityToSelection(ref);
      state.toggleEntitySelection(ref);

      assert.strictEqual(state.selectedEntitiesSet.size, 0);
    });

    it('should update primary selection correctly', () => {
      const ref1: EntityRef = { modelId: 'model-1', expressId: 123 };
      const ref2: EntityRef = { modelId: 'model-1', expressId: 456 };

      state.toggleEntitySelection(ref1);
      assert.deepStrictEqual(state.selectedEntity, ref1);

      state.toggleEntitySelection(ref2);
      assert.deepStrictEqual(state.selectedEntity, ref2);

      state.toggleEntitySelection(ref2);
      // After removing ref2, primary should go back to ref1
      assert.ok(state.selectedEntity?.expressId === 123 || state.selectedEntity === null);
    });
  });

  describe('multi-model selection: clearEntitySelection', () => {
    it('should clear all multi-model selection state', () => {
      const ref: EntityRef = { modelId: 'model-1', expressId: 123 };
      state.addEntityToSelection(ref);
      state.clearEntitySelection();

      assert.strictEqual(state.selectedEntity, null);
      assert.strictEqual(state.selectedEntitiesSet.size, 0);
      assert.strictEqual(state.selectedEntityId, null);
    });

    it('should also clear legacy selection state', () => {
      state.setSelectedEntityIds([1, 2, 3]);
      state.clearEntitySelection();

      assert.strictEqual(state.selectedEntityIds.size, 0);
    });
  });

  describe('multi-model selection: isEntitySelected', () => {
    it('should return true for selected entity', () => {
      const ref: EntityRef = { modelId: 'model-1', expressId: 123 };
      state.addEntityToSelection(ref);

      assert.strictEqual(state.isEntitySelected(ref), true);
    });

    it('should return false for non-selected entity', () => {
      const ref: EntityRef = { modelId: 'model-1', expressId: 123 };
      assert.strictEqual(state.isEntitySelected(ref), false);
    });

    it('should distinguish between models', () => {
      const ref1: EntityRef = { modelId: 'model-1', expressId: 123 };
      const ref2: EntityRef = { modelId: 'model-2', expressId: 123 }; // Same expressId, different model

      state.addEntityToSelection(ref1);

      assert.strictEqual(state.isEntitySelected(ref1), true);
      assert.strictEqual(state.isEntitySelected(ref2), false);
    });
  });

  describe('multi-model selection: getSelectedEntitiesForModel', () => {
    it('should return only entities for specified model', () => {
      state.addEntityToSelection({ modelId: 'model-1', expressId: 100 });
      state.addEntityToSelection({ modelId: 'model-1', expressId: 200 });
      state.addEntityToSelection({ modelId: 'model-2', expressId: 300 });

      const model1Entities = state.getSelectedEntitiesForModel('model-1');
      const model2Entities = state.getSelectedEntitiesForModel('model-2');

      assert.strictEqual(model1Entities.length, 2);
      assert.ok(model1Entities.includes(100));
      assert.ok(model1Entities.includes(200));

      assert.strictEqual(model2Entities.length, 1);
      assert.ok(model2Entities.includes(300));
    });

    it('should return empty array for model with no selections', () => {
      state.addEntityToSelection({ modelId: 'model-1', expressId: 100 });

      const result = state.getSelectedEntitiesForModel('model-2');
      assert.deepStrictEqual(result, []);
    });
  });

  describe('legacy selection: primary-id bookkeeping', () => {
    // `selectedEntityId` is the GLOBAL id the renderer highlights. Every
    // legacy multi-select action has to keep it pointing at the MOST RECENT
    // survivor of `selectedEntityIds`, otherwise the highlight box jumps to
    // an element the user did not touch last (or lingers after the last
    // element was deselected). None of that was pinned before.

    it('addToSelection makes the added id primary', () => {
      state.addToSelection(10);
      state.addToSelection(20);
      assert.deepStrictEqual([...state.selectedEntityIds].sort((a, b) => a - b), [10, 20]);
      assert.strictEqual(state.selectedEntityId, 20);
    });

    it('removeFromSelection promotes the LAST remaining id, not the first', () => {
      state.setSelectedEntityIds([10, 20, 30]);
      state.removeFromSelection(30);

      assert.deepStrictEqual([...state.selectedEntityIds].sort((a, b) => a - b), [10, 20]);
      // Insertion order is preserved by Set, so the last survivor is 20.
      assert.strictEqual(state.selectedEntityId, 20);
    });

    it('removeFromSelection clears the primary id when the set empties', () => {
      state.setSelectedEntityIds([10]);
      state.removeFromSelection(10);
      assert.strictEqual(state.selectedEntityIds.size, 0);
      assert.strictEqual(state.selectedEntityId, null);
    });

    it('toggleSelection adds then removes, keeping the primary id in step', () => {
      state.setSelectedEntityIds([10]);
      state.toggleSelection(20);
      assert.strictEqual(state.selectedEntityId, 20);

      state.toggleSelection(20);
      assert.deepStrictEqual([...state.selectedEntityIds], [10]);
      assert.strictEqual(state.selectedEntityId, 10);
    });

    it('setSelectedEntityIds makes the LAST id primary, and [] clears it', () => {
      state.setSelectedEntityIds([10, 20, 30]);
      assert.strictEqual(state.selectedEntityId, 30);

      state.setSelectedEntityIds([]);
      assert.strictEqual(state.selectedEntityIds.size, 0);
      assert.strictEqual(state.selectedEntityId, null);
    });

    it('clearSelection empties the set and the primary id', () => {
      state.setSelectedEntityIds([10, 20]);
      state.clearSelection();
      assert.strictEqual(state.selectedEntityIds.size, 0);
      assert.strictEqual(state.selectedEntityId, null);
    });
  });

  describe('entity vs model selection are mutually exclusive', () => {
    it('setSelectedEntityId clears selectedModelId when an entity is picked', () => {
      state.setSelectedModelId('model-1');
      state.setSelectedEntityId(42);
      // Otherwise the properties panel shows model metadata AND an element
      // at the same time — the panel binds to whichever it checks first.
      assert.strictEqual(state.selectedModelId, null);
      assert.strictEqual(state.selectedEntityId, 42);
    });

    it('setSelectedEntityId(null) does NOT clear selectedModelId', () => {
      // Opposite direction: clearing the entity highlight (e.g. an empty
      // canvas click while a model row is selected in the hierarchy) must
      // leave the model selection alone.
      state.setSelectedModelId('model-1');
      state.setSelectedEntityId(null);
      assert.strictEqual(state.selectedModelId, 'model-1');
    });

    it('setSelectedModelId clears every entity-selection channel', () => {
      state.setSelectedEntity({ modelId: 'model-1', expressId: 7 });
      state.setSelectedEntities([
        { modelId: 'model-1', expressId: 7 },
        { modelId: 'model-1', expressId: 8 },
      ]);
      state.setSelectedEntityIds([7, 8]);

      state.setSelectedModelId('model-1');

      assert.strictEqual(state.selectedModelId, 'model-1');
      assert.strictEqual(state.selectedEntity, null);
      assert.deepStrictEqual(state.selectedEntities, []);
      assert.strictEqual(state.selectedEntityId, null);
    });

    it('setSelectedEntities makes the FIRST ref primary and clears the model selection', () => {
      const refs: EntityRef[] = [
        { modelId: 'model-1', expressId: 7 },
        { modelId: 'model-2', expressId: 8 },
      ];
      state.setSelectedModelId('model-1');
      state.setSelectedEntities(refs);

      assert.deepStrictEqual(state.selectedEntities, refs);
      // Unified-storey display drives the property panel from the FIRST ref.
      assert.deepStrictEqual(state.selectedEntity, refs[0]);
      assert.strictEqual(state.selectedModelId, null);
    });

    it('setSelectedEntities([]) clears the primary entity', () => {
      state.setSelectedEntity({ modelId: 'model-1', expressId: 7 });
      state.setSelectedEntities([]);
      assert.strictEqual(state.selectedEntity, null);
    });
  });

  describe('legacy selection: storey selection', () => {
    it('should toggle storey selection', () => {
      state.toggleStoreySelection(1);
      assert.ok(state.selectedStoreys.has(1));

      state.toggleStoreySelection(1);
      assert.ok(!state.selectedStoreys.has(1));
    });

    it('should set single storey selection', () => {
      state.setStoreySelection(1);
      state.setStoreySelection(2);

      assert.strictEqual(state.selectedStoreys.size, 1);
      assert.ok(state.selectedStoreys.has(2));
    });

    it('should toggle off when selecting already-selected storey', () => {
      state.setStoreySelection(1);
      state.setStoreySelection(1);

      assert.strictEqual(state.selectedStoreys.size, 0);
    });

    it('should clear storey selection', () => {
      state.setStoreysSelection([1, 2, 3]);
      state.clearStoreySelection();

      assert.strictEqual(state.selectedStoreys.size, 0);
    });
  });

  describe('shared active storey', () => {
    it('defaults to null', () => {
      assert.strictEqual(state.activeStorey, null);
    });

    it('sets a model-aware active storey', () => {
      const ref: EntityRef = { modelId: 'model-1', expressId: 42 };
      state.setActiveStorey(ref);
      assert.deepStrictEqual(state.activeStorey, ref);
    });

    it('clears the active storey with null', () => {
      state.setActiveStorey({ modelId: 'model-1', expressId: 42 });
      state.setActiveStorey(null);
      assert.strictEqual(state.activeStorey, null);
    });

    it('is independent of the selectedStoreys renderer filter', () => {
      // The active storey is the single, model-aware focus; selectedStoreys
      // is the multi-select isolation filter. Writing one must not mutate the
      // other (the hierarchy sets both deliberately on a single-storey click).
      state.setActiveStorey({ modelId: 'model-1', expressId: 7 });
      assert.strictEqual(state.selectedStoreys.size, 0);

      state.setStoreysSelection([7, 8]);
      assert.deepStrictEqual(state.activeStorey, { modelId: 'model-1', expressId: 7 });
    });
  });
});
