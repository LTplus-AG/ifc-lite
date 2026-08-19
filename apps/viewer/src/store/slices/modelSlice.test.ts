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

/** The selection fields `removeModel` purges. They belong to another slice, so
 *  the slice under test reads them through a cast and so does this file. */
interface SelectionFields {
  selectedEntity: { modelId: string; expressId: number } | null;
  activeStorey: { modelId: string; expressId: number } | null;
  selectedEntities: Array<{ modelId: string; expressId: number }>;
  selectedEntitiesSet: Set<string>;
  selectedModelId: string | null;
}

/** The pinboard/basket fields `removeModel` purges (pinboardSlice). Same
 *  entityRef-string keying as `selectedEntitiesSet` above, reached the same
 *  way — through a cast, since the fields live on another slice. */
interface PinboardFields {
  pinboardEntities: Set<string>;
  hierarchyBasketSelection: Set<string>;
}

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
    state = {
      ...slice,
      ifcDataStore: null,
      geometryResult: null,
      addElementModelId: null,
      addElementStoreyId: null,
      selectedEntityId: null,
      selectedEntityIds: new Set(),
      selectedStoreys: new Set(),
      hiddenEntities: new Set(),
      isolatedEntities: null,
      ghostExceptEntities: null,
      classFilter: null,
      hiddenEntitiesByModel: new Map(),
      isolatedEntitiesByModel: new Map(),
      pinboardEntities: new Set<string>(),
      hierarchyBasketSelection: new Set<string>(),
    };
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

    // Regression for issue #661.
    it('keeps each model entry distinct when a second model is added', () => {
      const firstStore = { tag: 'first' } as unknown as IfcDataStore;
      const firstGeometry = { tag: 'first' } as unknown as GeometryResult;
      const secondStore = { tag: 'second' } as unknown as IfcDataStore;
      const secondGeometry = { tag: 'second' } as unknown as GeometryResult;

      const model1 = { ...createMockModel('model-1', 'First'), ifcDataStore: firstStore, geometryResult: firstGeometry };
      const model2 = { ...createMockModel('model-2', 'Second'), ifcDataStore: secondStore, geometryResult: secondGeometry };

      state.addModel(model1);
      state.addModel(model2);

      assert.strictEqual(state.models.get('model-1')?.ifcDataStore, firstStore);
      assert.strictEqual(state.models.get('model-1')?.geometryResult, firstGeometry);
      assert.strictEqual(state.models.get('model-2')?.ifcDataStore, secondStore);
      assert.strictEqual(state.models.get('model-2')?.geometryResult, secondGeometry);
    });
  });

  describe('upsertModel', () => {
    it('MERGES into an existing entry instead of replacing it', () => {
      // The ingest pipeline upserts a model twice: a metadata-only stub
      // first, then the parsed payload. A replacing (non-merging) upsert
      // would drop whatever the second call omits — the model's name /
      // georef / visibility silently reverting mid-load.
      const original = { ...createMockModel('model-1', 'Original'), maxExpressId: 999 };
      state.upsertModel(original);

      const geometry = { tag: 'late' } as unknown as GeometryResult;
      state.upsertModel({ id: 'model-1', geometryResult: geometry } as unknown as FederatedModel);

      assert.strictEqual(state.models.get('model-1')?.name, 'Original');
      assert.strictEqual(state.models.get('model-1')?.maxExpressId, 999);
      assert.strictEqual(state.models.get('model-1')?.geometryResult, geometry);
    });

    it('adopts the first upserted model as active and mirrors its payload', () => {
      const store = { tag: 'a' } as unknown as IfcDataStore;
      const geometry = { tag: 'a' } as unknown as GeometryResult;
      state.upsertModel({ ...createMockModel('model-1', 'A'), ifcDataStore: store, geometryResult: geometry });

      assert.strictEqual(state.activeModelId, 'model-1');
      assert.strictEqual(state.ifcDataStore, store);
      assert.strictEqual(state.geometryResult, geometry);
    });

    it('does not steal the active slot from an already-active model', () => {
      state.upsertModel(createMockModel('model-1', 'A'));
      state.upsertModel(createMockModel('model-2', 'B'));
      assert.strictEqual(state.activeModelId, 'model-1');
    });
  });

  describe('updateModel', () => {
    it('re-mirrors ifcDataStore / geometryResult when the ACTIVE model is patched', () => {
      // This is how the loader attaches parsed data to a model that was
      // registered earlier. If the mirror is not refreshed, the whole app
      // (properties panel, exports, queries) keeps reading the pre-parse
      // store while the model list shows the file as loaded.
      state.addModel(createMockModel('model-1', 'A'));
      const store = { tag: 'patched' } as unknown as IfcDataStore;
      const geometry = { tag: 'patched' } as unknown as GeometryResult;

      state.updateModel('model-1', { ifcDataStore: store, geometryResult: geometry });

      assert.strictEqual(state.models.get('model-1')?.ifcDataStore, store);
      assert.strictEqual(state.ifcDataStore, store);
      assert.strictEqual(state.geometryResult, geometry);
    });

    it('leaves the active mirror alone when a NON-active model is patched', () => {
      // Opposite direction of the same branch: patching a background model
      // must not swap the active model's data out from under the UI.
      const activeStore = { tag: 'active' } as unknown as IfcDataStore;
      const activeGeometry = { tag: 'active' } as unknown as GeometryResult;
      state.addModel({
        ...createMockModel('model-1', 'A'),
        ifcDataStore: activeStore,
        geometryResult: activeGeometry,
      });
      state.addModel(createMockModel('model-2', 'B'));
      assert.strictEqual(state.activeModelId, 'model-1');

      const otherStore = { tag: 'other' } as unknown as IfcDataStore;
      const otherGeometry = { tag: 'other' } as unknown as GeometryResult;
      state.updateModel('model-2', { ifcDataStore: otherStore, geometryResult: otherGeometry });

      // BOTH mirrors are gated on `activeModelId` (modelSlice.ts:112-113), so
      // both directions need pinning. Patching only `ifcDataStore` here left
      // the geometry gate free to be deleted outright without any test
      // noticing — and the geometry mirror is what the viewport renders.
      assert.strictEqual(state.ifcDataStore, activeStore);
      assert.strictEqual(state.geometryResult, activeGeometry);
      assert.strictEqual(state.models.get('model-2')?.ifcDataStore, otherStore);
      assert.strictEqual(state.models.get('model-2')?.geometryResult, otherGeometry);
    });

    it('is a no-op for an unknown model id', () => {
      state.addModel(createMockModel('model-1', 'A'));
      state.updateModel('does-not-exist', { name: 'Ghost' });

      assert.strictEqual(state.models.size, 1);
      assert.ok(!state.models.has('does-not-exist'));
      assert.strictEqual(state.models.get('model-1')?.name, 'A');
      // "No-op" has to mean the rest of the slice too, not just the map:
      // an early return that still emits a state patch would point the
      // active-model pointer (and the mirrored stores) at an id that does
      // not exist. Asserting only the map cannot see that — measured.
      assert.strictEqual(state.activeModelId, 'model-1');
      assert.strictEqual(state.ifcDataStore, state.models.get('model-1')?.ifcDataStore ?? null);
      assert.strictEqual(state.geometryResult, state.models.get('model-1')?.geometryResult ?? null);
    });
  });

  describe('removeModel', () => {
    it('should remove a model from the map', () => {
      const model = createMockModel('model-1', 'Test Model');
      state.addModel(model);
      state.removeModel('model-1');
      assert.strictEqual(state.models.size, 0);
    });

    it('discards the removed model\'s mutation footprint', () => {
      // removeModel clears the model's mutation view/stacks/georef/schedule via
      // cross-slice actions so getModifiedEntityCount stops counting it and no
      // schedule source dangles. Stub the cross-slice actions and assert the
      // wiring (the actions themselves are covered by the mutation slice).
      const model = createMockModel('model-1', 'Test Model');
      state.addModel(model);

      const clearedMutations: string[] = [];
      const clearedViews: string[] = [];
      let scheduleCleared = 0;
      (state as unknown as { clearMutations: (id: string) => void }).clearMutations = (id) =>
        clearedMutations.push(id);
      (state as unknown as { clearMutationView: (id: string) => void }).clearMutationView = (id) =>
        clearedViews.push(id);
      (state as unknown as { clearGeneratedSchedule: () => number }).clearGeneratedSchedule = () => {
        scheduleCleared++;
        return 0;
      };

      state.removeModel('model-1');

      assert.deepStrictEqual(clearedMutations, ['model-1']);
      assert.deepStrictEqual(clearedViews, ['model-1']);
      // model-1 was the only model, so its orphaned schedule is cleared too.
      assert.strictEqual(scheduleCleared, 1);
      assert.strictEqual(state.models.size, 0);
    });

    it('does not clear the schedule when other models remain', () => {
      state.addModel(createMockModel('model-1', 'First'));
      state.addModel(createMockModel('model-2', 'Second'));

      let scheduleCleared = 0;
      (state as unknown as { clearGeneratedSchedule: () => number }).clearGeneratedSchedule = () => {
        scheduleCleared++;
        return 0;
      };

      state.removeModel('model-1');

      // model-2 still loaded — a schedule could belong to it, so keep it.
      assert.strictEqual(scheduleCleared, 0);
      assert.strictEqual(state.models.size, 1);
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

    it('purges the REMOVED model from the selection and keeps every survivor', () => {
      // github.com/LTplus-AG/ifc-lite/issues/2765: inverting this filter to
      // `===` left 37 tests green. It is the exact inversion that keeps
      // selection pointing at entities of a model that is gone while dropping
      // the selection of every model still loaded, and no assertion anywhere
      // looked at which entities survived.
      state.addModel(createMockModel('model-1', 'First'));
      state.addModel(createMockModel('model-2', 'Second'));
      const gone = { modelId: 'model-1', expressId: 11 };
      const kept = { modelId: 'model-2', expressId: 22 };
      Object.assign(state, {
        selectedEntity: gone,
        activeStorey: gone,
        selectedModelId: 'model-1',
        selectedEntities: [gone, kept],
        selectedEntitiesSet: new Set(['model-1:11', 'model-2:22']),
      });

      state.removeModel('model-1');

      // The slice reaches across to the selection fields through a cast (they
      // live in another slice), so the test reads them the same way.
      const after = state as unknown as SelectionFields;
      assert.deepStrictEqual(after.selectedEntities, [kept], 'the survivor stays selected');
      assert.deepStrictEqual([...(after.selectedEntitiesSet ?? [])], ['model-2:22']);
      assert.strictEqual(after.selectedEntity, null, 'the removed model cannot stay the selection');
      assert.strictEqual(after.activeStorey, null);
      assert.strictEqual(after.selectedModelId, null);
    });

    it('leaves the selection untouched when the removed model owned none of it', () => {
      // The bounding control: a purge that fires on every removal would also
      // pass the assertions above if it simply cleared everything.
      state.addModel(createMockModel('model-1', 'First'));
      state.addModel(createMockModel('model-2', 'Second'));
      const kept = { modelId: 'model-2', expressId: 22 };
      Object.assign(state, {
        selectedEntity: kept,
        activeStorey: kept,
        selectedModelId: 'model-2',
        selectedEntities: [kept],
        selectedEntitiesSet: new Set(['model-2:22']),
      });

      state.removeModel('model-1');

      const after = state as unknown as SelectionFields;
      assert.deepStrictEqual(after.selectedEntities, [kept]);
      assert.strictEqual(after.selectedEntity, kept);
      assert.strictEqual(after.selectedModelId, 'model-2');
    });

    it('should not affect activeModelId if removed model was not active', () => {
      const model1 = createMockModel('model-1', 'First Model');
      const model2 = createMockModel('model-2', 'Second Model');

      state.addModel(model1);
      state.addModel(model2);

      state.removeModel('model-2');
      assert.strictEqual(state.activeModelId, 'model-1');
    });

    it('clears the AddElement panel pin when it names the removed model', () => {
      // addElementSlice's `addElementModelId` / `addElementStoreyId` name a
      // specific federated model the panel is pinned to (set via its Model
      // dropdown). Nothing else clears it, so a stale pin survives removal
      // and the panel keeps naming a model no longer in `models` — the same
      // shape as the selection-purge tests above, on a different slice.
      state.addModel(createMockModel('model-1', 'First'));
      state.addModel(createMockModel('model-2', 'Second'));
      Object.assign(state, { addElementModelId: 'model-1', addElementStoreyId: 42 });

      state.removeModel('model-1');

      const after = state as unknown as { addElementModelId: string | null; addElementStoreyId: number | null };
      assert.strictEqual(after.addElementModelId, null);
      assert.strictEqual(after.addElementStoreyId, null);
    });

    it('leaves the AddElement panel pin untouched when it names a surviving model', () => {
      state.addModel(createMockModel('model-1', 'First'));
      state.addModel(createMockModel('model-2', 'Second'));
      Object.assign(state, { addElementModelId: 'model-2', addElementStoreyId: 7 });

      state.removeModel('model-1');

      const after = state as unknown as { addElementModelId: string | null; addElementStoreyId: number | null };
      assert.strictEqual(after.addElementModelId, 'model-2');
      assert.strictEqual(after.addElementStoreyId, 7);
    });

    describe('global-id state (selection sets / hidden / isolated / ghost / class filter)', () => {
      // `syncSourceModel.ts`'s `purgeStaleEntityState` already purges these
      // exact fields on the same-modelId resync path (comment above this
      // block's parent `describe`). `removeModel` never got the same
      // treatment for anything past the EntityRef-shaped selection fields —
      // these are keyed by bare `globalId`, not `{modelId, expressId}`, so a
      // stale entry can't be spotted by comparing `.modelId`; it has to be
      // resolved against which surviving model's parse/overlay range owns it.
      function federatedModel(id: string, idOffset: number): FederatedModel {
        const m = createMockModel(id, id);
        m.idOffset = idOffset;
        m.maxExpressId = 100;
        return m;
      }

      it('clears isolatedEntities to null when every isolated id belonged to the removed model', () => {
        state.addModel(federatedModel('model-1', 0));
        state.addModel(federatedModel('model-2', 1000));
        Object.assign(state, { isolatedEntities: new Set([5, 7]) });

        state.removeModel('model-1');

        // A non-null empty Set would still read as "isolation active,
        // nothing matches" and hide every surviving entity — worse than the
        // dangling ids it replaces. Must be null, not an empty Set.
        assert.strictEqual((state as unknown as { isolatedEntities: unknown }).isolatedEntities, null);
      });

      it('keeps the surviving id and drops only the removed model\'s id from a mixed isolatedEntities set', () => {
        state.addModel(federatedModel('model-1', 0));
        state.addModel(federatedModel('model-2', 1000));
        // 5 belongs to model-1 (offset 0), 1005 belongs to model-2 (offset 1000).
        Object.assign(state, { isolatedEntities: new Set([5, 1005]) });

        state.removeModel('model-1');

        const after = state as unknown as { isolatedEntities: Set<number> | null };
        assert.deepStrictEqual(after.isolatedEntities, new Set([1005]));
      });

      it('leaves isolatedEntities untouched when it names no id from the removed model', () => {
        state.addModel(federatedModel('model-1', 0));
        state.addModel(federatedModel('model-2', 1000));
        Object.assign(state, { isolatedEntities: new Set([1005]) });

        state.removeModel('model-1');

        const after = state as unknown as { isolatedEntities: Set<number> | null };
        assert.deepStrictEqual(after.isolatedEntities, new Set([1005]));
      });

      it('purges ghostExceptEntities, hiddenEntities, selectedEntityIds, selectedStoreys and classFilter the same way', () => {
        state.addModel(federatedModel('model-1', 0));
        state.addModel(federatedModel('model-2', 1000));
        Object.assign(state, {
          ghostExceptEntities: new Set([5, 1005]),
          hiddenEntities: new Set([6, 1006]),
          selectedEntityIds: new Set([7, 1007]),
          selectedStoreys: new Set([8, 1008]),
          selectedEntityId: 9,
          classFilter: { ids: new Set([10, 1010]), label: 'Walls' },
        });

        state.removeModel('model-1');

        const after = state as unknown as {
          ghostExceptEntities: Set<number> | null;
          hiddenEntities: Set<number>;
          selectedEntityIds: Set<number>;
          selectedStoreys: Set<number>;
          selectedEntityId: number | null;
          classFilter: { ids: Set<number>; label: string } | null;
        };
        assert.deepStrictEqual(after.ghostExceptEntities, new Set([1005]));
        assert.deepStrictEqual(after.hiddenEntities, new Set([1006]));
        assert.deepStrictEqual(after.selectedEntityIds, new Set([1007]));
        assert.deepStrictEqual(after.selectedStoreys, new Set([1008]));
        assert.strictEqual(after.selectedEntityId, null, 'id 9 belonged only to the removed model');
        assert.deepStrictEqual(after.classFilter, { ids: new Set([1010]), label: 'Walls' });
      });

      it('drops the removed model\'s key from hiddenEntitiesByModel / isolatedEntitiesByModel', () => {
        state.addModel(federatedModel('model-1', 0));
        state.addModel(federatedModel('model-2', 1000));
        Object.assign(state, {
          hiddenEntitiesByModel: new Map([['model-1', new Set([1])], ['model-2', new Set([2])]]),
          isolatedEntitiesByModel: new Map([['model-1', new Set([3])], ['model-2', new Set([4])]]),
        });

        state.removeModel('model-1');

        const after = state as unknown as {
          hiddenEntitiesByModel: Map<string, Set<number>>;
          isolatedEntitiesByModel: Map<string, Set<number>>;
        };
        assert.strictEqual(after.hiddenEntitiesByModel.has('model-1'), false);
        assert.strictEqual(after.hiddenEntitiesByModel.has('model-2'), true);
        assert.strictEqual(after.isolatedEntitiesByModel.has('model-1'), false);
        assert.strictEqual(after.isolatedEntitiesByModel.has('model-2'), true);
      });
    it('purges the REMOVED model\'s refs from the pinboard basket and keeps every survivor', () => {
      // pinboardSlice's `pinboardEntities` / `hierarchyBasketSelection` are
      // Set<string> of entityRef strings ("modelId:expressId"), the exact
      // same shape `selectedEntitiesSet` already gets purged above. Nothing
      // purged these: `pinboardEntities` is the documented "source of truth"
      // basket set (see pinboardSlice.ts's cross-slice-state comment) that
      // `addToBasket`/`removeFromBasket`/`showPinboard` re-derive
      // `isolatedEntities` from via `toGlobalIdForRef` on every subsequent
      // basket edit — and `toGlobalIdFromModels` falls back to the RAW,
      // un-offset expressId when the ref's modelId is no longer in `models`.
      // A stale "model-1:42" surviving removal therefore doesn't just dangle:
      // the next basket operation resolves it to bare global id 42, which can
      // collide with a real entity in a model whose own offset range covers
      // 42 (e.g. any model with idOffset 0), silently co-isolating/hiding an
      // entity the user never selected.
      state.addModel(createMockModel('model-1', 'First'));
      state.addModel(createMockModel('model-2', 'Second'));
      Object.assign(state, {
        pinboardEntities: new Set(['model-1:42', 'model-2:7']),
        hierarchyBasketSelection: new Set(['model-1:1', 'model-2:2']),
      });

      state.removeModel('model-1');

      const after = state as unknown as PinboardFields;
      assert.deepStrictEqual([...after.pinboardEntities], ['model-2:7'], 'the survivor stays in the basket');
      assert.deepStrictEqual(
        [...after.hierarchyBasketSelection],
        ['model-2:2'],
        'the survivor stays in the hierarchy-derived basket source',
      );
    });

    it('leaves the pinboard basket untouched when it names no ref from the removed model', () => {
      state.addModel(createMockModel('model-1', 'First'));
      state.addModel(createMockModel('model-2', 'Second'));
      Object.assign(state, {
        pinboardEntities: new Set(['model-2:7']),
        hierarchyBasketSelection: new Set(['model-2:2']),
      });

      state.removeModel('model-1');

      const after = state as unknown as PinboardFields;
      assert.deepStrictEqual([...after.pinboardEntities], ['model-2:7']);
      assert.deepStrictEqual([...after.hierarchyBasketSelection], ['model-2:2']);
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

    it('clears the AddElement panel pin along with every model', () => {
      state.addModel(createMockModel('model-1', 'First'));
      Object.assign(state, { addElementModelId: 'model-1', addElementStoreyId: 5 });

      state.clearAllModels();

      const after = state as unknown as { addElementModelId: string | null; addElementStoreyId: number | null };
      assert.strictEqual(after.addElementModelId, null);
      assert.strictEqual(after.addElementStoreyId, null);
    });

    it('clears every global-id set (isolate/ghost/hidden/selection/class filter) unconditionally', () => {
      state.addModel(createMockModel('model-1', 'First'));
      Object.assign(state, {
        isolatedEntities: new Set([1]),
        ghostExceptEntities: new Set([2]),
        hiddenEntities: new Set([3]),
        selectedEntityIds: new Set([4]),
        selectedStoreys: new Set([5]),
        selectedEntityId: 6,
        classFilter: { ids: new Set([7]), label: 'Doors' },
        hiddenEntitiesByModel: new Map([['model-1', new Set([8])]]),
        isolatedEntitiesByModel: new Map([['model-1', new Set([9])]]),
      });

      state.clearAllModels();

      const after = state as unknown as {
        isolatedEntities: unknown;
        ghostExceptEntities: unknown;
        hiddenEntities: Set<number>;
        selectedEntityIds: Set<number>;
        selectedStoreys: Set<number>;
        selectedEntityId: number | null;
        classFilter: unknown;
        hiddenEntitiesByModel: Map<string, Set<number>>;
        isolatedEntitiesByModel: Map<string, Set<number>>;
      };
      assert.strictEqual(after.isolatedEntities, null);
      assert.strictEqual(after.ghostExceptEntities, null);
      assert.strictEqual(after.hiddenEntities.size, 0);
      assert.strictEqual(after.selectedEntityIds.size, 0);
      assert.strictEqual(after.selectedStoreys.size, 0);
      assert.strictEqual(after.selectedEntityId, null);
      assert.strictEqual(after.classFilter, null);
      assert.strictEqual(after.hiddenEntitiesByModel.size, 0);
      assert.strictEqual(after.isolatedEntitiesByModel.size, 0);
    });

    it('clears the pinboard basket along with every model', () => {
      state.addModel(createMockModel('model-1', 'First'));
      Object.assign(state, {
        pinboardEntities: new Set(['model-1:42']),
        hierarchyBasketSelection: new Set(['model-1:1']),
      });

      state.clearAllModels();

      const after = state as unknown as PinboardFields;
      assert.strictEqual(after.pinboardEntities.size, 0);
      assert.strictEqual(after.hierarchyBasketSelection.size, 0);
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

  describe('resolveGlobalIdFromModels — maxExpressId boundary', () => {
    it('resolves the highest parsed express id through the fast (first) pass', () => {
      const model = createMockModel('model-1', 'First');
      model.idOffset = 0;
      model.maxExpressId = 10_000;
      state.addModel(model);

      // No mutation views registered at all — if the boundary id fell
      // through to the second pass, there would be nothing to catch it
      // and this would resolve to null instead of the model.
      const boundary = state.resolveGlobalIdFromModels(model.maxExpressId);
      assert.deepStrictEqual(boundary, { modelId: 'model-1', expressId: model.maxExpressId });
    });

    it('resolves the first model boundary id in a federated (offset) setup, not the second model', () => {
      const first = createMockModel('model-1', 'First');
      first.idOffset = 0;
      first.maxExpressId = 10_000;
      state.addModel(first);

      const second = createMockModel('model-2', 'Second');
      second.idOffset = 10_000;
      second.maxExpressId = 5_000;
      state.addModel(second);

      // globalId 10_000 is the last express id parsed for `model-1`
      // (localId = 10_000 - 0 = 10_000 === maxExpressId) and simultaneously
      // localId 0 of `model-2` (10_000 - 10_000 = 0), which is also in
      // range for the second model. Models are sorted by offset ascending,
      // so the first model — the one that actually owns this id as its
      // boundary — must win.
      const boundary = state.resolveGlobalIdFromModels(10_000);
      assert.deepStrictEqual(boundary, { modelId: 'model-1', expressId: 10_000 });
    });
  });
});
