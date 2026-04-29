/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult } from '@ifc-lite/geometry';
import { createModelSlice, type ModelSlice, type ModelCrossSliceState } from './modelSlice.js';
import type { FederatedModel } from '../types.js';

type ModelTestState = ModelSlice & ModelCrossSliceState;

// Typed setter / getter shim that mirrors zustand's StateCreator
// signature without the broader middleware machinery the test doesn't
// need. Using StateCreator's exact types here would pull in the whole
// store; the local aliases below are tight enough for this test.
type TestSetState = (
  partial:
    | Partial<ModelTestState>
    | ((state: ModelTestState) => Partial<ModelTestState>),
) => void;
type TestGetState = () => ModelTestState;

// Helper to create a mock model. `IfcDataStore` and `GeometryResult` are
// large interfaces that the slice never inspects on these paths — the
// double-cast through `unknown` is the minimum that satisfies the
// compiler without an `any`.
function createMockModel(id: string, name: string): FederatedModel {
  return {
    id,
    name,
    ifcDataStore: {} as unknown as IfcDataStore,
    geometryResult: {} as unknown as GeometryResult,
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
  let setState: TestSetState;

  beforeEach(() => {
    setState = (partial) => {
      if (typeof partial === 'function') {
        const updates = partial(state);
        state = { ...state, ...updates };
      } else {
        state = { ...state, ...partial };
      }
    };

    const getState: TestGetState = () => state;

    // The slice's StateCreator signature includes a third middleware
    // argument (store API) that the slice's body never reads. We pass
    // `undefined` cast to the empty middleware shape rather than `any`.
    const slice = createModelSlice(
      setState as Parameters<typeof createModelSlice>[0],
      getState as Parameters<typeof createModelSlice>[1],
      undefined as unknown as Parameters<typeof createModelSlice>[2],
    );
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

      // Seed a fake mutation view with a fresh overlay entity. The
      // resolver only reads `getNewEntity` from each view, so we type
      // the map narrowly and let it satisfy the slice's wider type via
      // a single-property cast on the wrapping state object.
      type StubView = { getNewEntity: (id: number) => { expressId: number } | null };
      const stubViews: Map<string, StubView> = new Map([
        ['model-1', { getNewEntity: (id: number) => (id === 11_001 ? { expressId: id } : null) }],
      ]);
      state = { ...state, mutationViews: stubViews } as typeof state & { mutationViews: Map<string, StubView> };

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
