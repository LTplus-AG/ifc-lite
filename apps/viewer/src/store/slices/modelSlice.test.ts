/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createModelSlice, type ModelSlice, type ModelCrossSliceState } from './modelSlice.js';
import type { FederatedModel } from '../types.js';

type ModelTestState = ModelSlice & ModelCrossSliceState;

// Helper to create a mock model
function createMockModel(id: string, name: string): FederatedModel {
  return {
    id,
    name,
    ifcDataStore: {} as any,
    geometryResult: {} as any,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: Date.now(),
    fileSize: 1024,
    idOffset: 0,
    maxExpressId: 0,
  };
}

describe('ModelSlice', () => {
  let state: ModelTestState;
  let setState: (partial: Partial<ModelTestState> | ((state: ModelTestState) => Partial<ModelTestState>)) => void;

  beforeEach(() => {
    // Create a mock set function that updates state
    setState = (partial) => {
      if (typeof partial === 'function') {
        const updates = partial(state);
        state = { ...state, ...updates };
      } else {
        state = { ...state, ...partial };
      }
    };

    // Seed cross-slice fields owned by dataSlice. The slice writes them
    // through cross-slice set() calls; the test mock has to provide them
    // so the typed StateCreator is satisfied.
    const slice = createModelSlice(setState as any, (() => state) as any, {} as any);
    state = { ...slice, ifcDataStore: null, geometryResult: null };
  });

  describe('initial state', () => {
    it('should have empty models map', () => {
      assert.strictEqual(state.models.size, 0);
    });

    it('should have null activeModelId', () => {
      assert.strictEqual(state.activeModelId, null);
    });

    it('should report hasModels as false', () => {
      assert.strictEqual(state.hasModels(), false);
    });
  });

  describe('addModel', () => {
    it('should add a model to the map', () => {
      const model = createMockModel('model-1', 'Test Model');
      state.addModel(model);
      assert.strictEqual(state.models.size, 1);
      assert.strictEqual(state.models.get('model-1')?.name, 'Test Model');
    });

    it('should set first model as active', () => {
      const model = createMockModel('model-1', 'Test Model');
      state.addModel(model);
      assert.strictEqual(state.activeModelId, 'model-1');
    });

    it('should collapse existing models when adding new ones', () => {
      const model1 = createMockModel('model-1', 'First Model');
      const model2 = createMockModel('model-2', 'Second Model');

      state.addModel(model1);
      assert.strictEqual(state.models.get('model-1')?.collapsed, false);

      state.addModel(model2);
      // First model should now be collapsed
      assert.strictEqual(state.models.get('model-1')?.collapsed, true);
      // New model should not be collapsed
      assert.strictEqual(state.models.get('model-2')?.collapsed, false);
    });

    it('should not change activeModelId when adding subsequent models', () => {
      const model1 = createMockModel('model-1', 'First Model');
      const model2 = createMockModel('model-2', 'Second Model');

      state.addModel(model1);
      state.addModel(model2);

      // Active model should still be the first one
      assert.strictEqual(state.activeModelId, 'model-1');
    });

    it('should report hasModels as true after adding', () => {
      const model = createMockModel('model-1', 'Test Model');
      state.addModel(model);
      assert.strictEqual(state.hasModels(), true);
    });
  });

  describe('removeModel', () => {
    it('should remove a model from the map', () => {
      const model = createMockModel('model-1', 'Test Model');
      state.addModel(model);
      state.removeModel('model-1');
      assert.strictEqual(state.models.size, 0);
    });

    it('should update activeModelId if removed model was active', () => {
      const model1 = createMockModel('model-1', 'First Model');
      const model2 = createMockModel('model-2', 'Second Model');

      state.addModel(model1);
      state.addModel(model2);
      state.setActiveModel('model-1');

      state.removeModel('model-1');
      // Active model should switch to model-2
      assert.strictEqual(state.activeModelId, 'model-2');
    });

    it('should set activeModelId to null when last model removed', () => {
      const model = createMockModel('model-1', 'Test Model');
      state.addModel(model);
      state.removeModel('model-1');
      assert.strictEqual(state.activeModelId, null);
    });

    it('should not affect activeModelId if removed model was not active', () => {
      const model1 = createMockModel('model-1', 'First Model');
      const model2 = createMockModel('model-2', 'Second Model');

      state.addModel(model1);
      state.addModel(model2);

      state.removeModel('model-2');
      assert.strictEqual(state.activeModelId, 'model-1');
    });
  });

  describe('clearAllModels', () => {
    it('should remove all models', () => {
      state.addModel(createMockModel('model-1', 'First'));
      state.addModel(createMockModel('model-2', 'Second'));

      state.clearAllModels();

      assert.strictEqual(state.models.size, 0);
      assert.strictEqual(state.activeModelId, null);
    });
  });

  describe('setActiveModel', () => {
    it('should update activeModelId', () => {
      const model1 = createMockModel('model-1', 'First Model');
      const model2 = createMockModel('model-2', 'Second Model');

      state.addModel(model1);
      state.addModel(model2);

      state.setActiveModel('model-2');
      assert.strictEqual(state.activeModelId, 'model-2');
    });

    it('should allow setting to null', () => {
      const model = createMockModel('model-1', 'Test Model');
      state.addModel(model);
      state.setActiveModel(null);
      assert.strictEqual(state.activeModelId, null);
    });
  });

  describe('setModelVisibility', () => {
    it('should update model visibility', () => {
      const model = createMockModel('model-1', 'Test Model');
      state.addModel(model);

      state.setModelVisibility('model-1', false);
      assert.strictEqual(state.models.get('model-1')?.visible, false);

      state.setModelVisibility('model-1', true);
      assert.strictEqual(state.models.get('model-1')?.visible, true);
    });

    it('should do nothing for non-existent model', () => {
      state.setModelVisibility('non-existent', false);
      // Should not throw, just return empty update
      assert.strictEqual(state.models.size, 0);
    });
  });

  describe('setModelCollapsed', () => {
    it('should update model collapsed state', () => {
      const model = createMockModel('model-1', 'Test Model');
      state.addModel(model);

      state.setModelCollapsed('model-1', true);
      assert.strictEqual(state.models.get('model-1')?.collapsed, true);

      state.setModelCollapsed('model-1', false);
      assert.strictEqual(state.models.get('model-1')?.collapsed, false);
    });
  });

  describe('setModelName', () => {
    it('should update model name', () => {
      const model = createMockModel('model-1', 'Original Name');
      state.addModel(model);

      state.setModelName('model-1', 'New Name');
      assert.strictEqual(state.models.get('model-1')?.name, 'New Name');
    });
  });

  describe('getModel', () => {
    it('should return model by ID', () => {
      const model = createMockModel('model-1', 'Test Model');
      state.addModel(model);

      const retrieved = state.getModel('model-1');
      assert.strictEqual(retrieved?.name, 'Test Model');
    });

    it('should return undefined for non-existent ID', () => {
      const retrieved = state.getModel('non-existent');
      assert.strictEqual(retrieved, undefined);
    });
  });

  describe('getActiveModel', () => {
    it('should return the active model', () => {
      const model = createMockModel('model-1', 'Test Model');
      state.addModel(model);

      const active = state.getActiveModel();
      assert.strictEqual(active?.id, 'model-1');
    });

    it('should return undefined when no active model', () => {
      const active = state.getActiveModel();
      assert.strictEqual(active, undefined);
    });
  });

  describe('getAllVisibleModels', () => {
    it('should return only visible models', () => {
      state.addModel(createMockModel('model-1', 'First'));
      state.addModel(createMockModel('model-2', 'Second'));
      state.addModel(createMockModel('model-3', 'Third'));

      state.setModelVisibility('model-2', false);

      const visible = state.getAllVisibleModels();
      assert.strictEqual(visible.length, 2);
      assert.ok(visible.some(m => m.id === 'model-1'));
      assert.ok(visible.some(m => m.id === 'model-3'));
      assert.ok(!visible.some(m => m.id === 'model-2'));
    });

    it('should return empty array when all models hidden', () => {
      state.addModel(createMockModel('model-1', 'First'));
      state.setModelVisibility('model-1', false);

      const visible = state.getAllVisibleModels();
      assert.strictEqual(visible.length, 0);
    });
  });

  describe('resolveGlobalIdFromModels — overlay-allocated ids', () => {
    it('falls through to mutation views when the id is past maxExpressId', () => {
      const model = createMockModel('model-1', 'First');
      model.idOffset = 0;
      model.maxExpressId = 10_000;
      state.addModel(model);

      // Seed a fake mutation view with a fresh overlay entity. Cast
      // through `unknown` since the test mock only exposes the
      // `getNewEntity` shape the resolver consults.
      state = {
        ...state,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mutationViews: new Map([
          ['model-1', { getNewEntity: (id: number) => (id === 11_001 ? { expressId: id } : null) }],
        ]) as any,
      };

      // Inside the parsed range — first pass resolves it.
      const within = state.resolveGlobalIdFromModels(42);
      assert.deepStrictEqual(within, { modelId: 'model-1', expressId: 42 });

      // Above the parsed range but in the overlay — second pass resolves it.
      const overlay = state.resolveGlobalIdFromModels(11_001);
      assert.deepStrictEqual(overlay, { modelId: 'model-1', expressId: 11_001 });

      // Above the parsed range and NOT in the overlay — returns null
      // so callers can fall back to the legacy single-model path.
      const phantom = state.resolveGlobalIdFromModels(99_999);
      assert.strictEqual(phantom, null);
    });
  });
});
