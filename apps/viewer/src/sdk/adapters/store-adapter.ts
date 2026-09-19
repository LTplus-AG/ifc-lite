/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.store.*` adapter — implements StoreBackendMethods on top of the
 * viewer's per-model MutablePropertyView. Routes through the same overlay
 * that bim.mutate.* uses, so document-level edits and property edits stack
 * coherently into a single export.
 */

import { StoreEditor } from '@ifc-lite/mutations';
import {
  addBeamToStore,
  addColumnToStore,
  addDoorToStore,
  addMemberToStore,
  addPlateToStore,
  addRoofToStore,
  addSlabToStore,
  addSpaceToStore,
  addWallToStore,
  addWindowToStore,
  resolveSpatialAnchor,
  type BeamInStoreParams,
  type ColumnInStoreParams,
  type DoorInStoreParams,
  type MemberInStoreParams,
  type PlateInStoreParams,
  type RoofInStoreParams,
  type SlabInStoreParams,
  type SpaceInStoreParams,
  type WallInStoreParams,
  type WindowInStoreParams,
} from '@ifc-lite/create';
import { createCostStoreBackend } from '@ifc-lite/sdk';
import type {
  AddBeamInStoreParams,
  AddColumnInStoreParams,
  AddDoorInStoreParams,
  AddMemberInStoreParams,
  AddPlateInStoreParams,
  AddRoofInStoreParams,
  AddSlabInStoreParams,
  AddSpaceInStoreParams,
  AddWallInStoreParams,
  AddWindowInStoreParams,
  EntityRef,
  StoreBackendMethods,
} from '@ifc-lite/sdk';
import type { StoreApi } from './types.js';
import { getModelForRef, LEGACY_MODEL_ID } from './model-compat.js';
import { getOrCreateMutationView, normalizeMutationModelId } from './mutation-view.js';
import { createCostAdapter } from './cost-adapter.js';

export function createStoreAdapter(store: StoreApi): StoreBackendMethods {
  // One StoreEditor per (modelId, MutablePropertyView) pair. Editors are
  // cheap, but caching avoids re-scanning the entity index on every call.
  const editors = new WeakMap<object, StoreEditor>();
  // Cost authoring reads through the model's OWN bim.cost adapter (mutation-
  // aware), not a second cost-graph extraction — one read path, same as CLI.
  const costAdapter = createCostAdapter(store);

  function resolveDataStore(modelId: string) {
    const state = store.getState();
    const refModelId = modelId === 'legacy' ? LEGACY_MODEL_ID : modelId;
    const model = getModelForRef(state, refModelId);
    return model?.ifcDataStore ?? null;
  }

  function getEditor(modelId: string): StoreEditor | null {
    const view = getOrCreateMutationView(store, modelId);
    if (!view) return null;
    let editor = editors.get(view);
    if (editor) return editor;

    const dataStore = resolveDataStore(modelId);
    if (!dataStore) return null;

    editor = new StoreEditor(dataStore, view);
    editors.set(view, editor);
    return editor;
  }

  return {
    addEntity(modelId: string, def: { type: string; attributes: unknown[] }): EntityRef {
      const normalizedId = normalizeMutationModelId(store.getState(), modelId);
      const editor = getEditor(modelId);
      if (!editor) {
        throw new Error(`bim.store.addEntity: no model loaded for id "${modelId}"`);
      }
      const ref = editor.addEntity(def.type, def.attributes as Parameters<StoreEditor['addEntity']>[1]);
      return { modelId: normalizedId, expressId: ref.expressId };
    },
    removeEntity(ref: EntityRef): boolean {
      const editor = getEditor(ref.modelId);
      if (!editor) return false;
      return editor.removeEntity(ref.expressId);
    },
    setPositionalAttribute(ref: EntityRef, index: number, value: unknown): void {
      const editor = getEditor(ref.modelId);
      if (!editor) {
        throw new Error(`bim.store.setPositionalAttribute: no model loaded for id "${ref.modelId}"`);
      }
      editor.setPositionalAttribute(ref.expressId, index, value as Parameters<StoreEditor['setPositionalAttribute']>[2]);
    },
    addColumn(modelId: string, storeyExpressId: number, params: AddColumnInStoreParams): EntityRef {
      const editor = getEditor(modelId);
      const dataStore = resolveDataStore(modelId);
      if (!editor || !dataStore) {
        throw new Error(`bim.store.addColumn: no model loaded for id "${modelId}"`);
      }
      const anchor = resolveSpatialAnchor(dataStore, storeyExpressId);
      const normalizedModelId = normalizeMutationModelId(store.getState(), modelId);
      const result = addColumnToStore(editor, anchor, params as ColumnInStoreParams);
      return { modelId: normalizedModelId, expressId: result.columnId };
    },
    addWall(modelId: string, storeyExpressId: number, params: AddWallInStoreParams): EntityRef {
      const editor = getEditor(modelId);
      const dataStore = resolveDataStore(modelId);
      if (!editor || !dataStore) {
        throw new Error(`bim.store.addWall: no model loaded for id "${modelId}"`);
      }
      const anchor = resolveSpatialAnchor(dataStore, storeyExpressId);
      const normalizedModelId = normalizeMutationModelId(store.getState(), modelId);
      const result = addWallToStore(editor, anchor, params as WallInStoreParams);
      return { modelId: normalizedModelId, expressId: result.wallId };
    },
    addSlab(modelId: string, storeyExpressId: number, params: AddSlabInStoreParams): EntityRef {
      const editor = getEditor(modelId);
      const dataStore = resolveDataStore(modelId);
      if (!editor || !dataStore) {
        throw new Error(`bim.store.addSlab: no model loaded for id "${modelId}"`);
      }
      const anchor = resolveSpatialAnchor(dataStore, storeyExpressId);
      const normalizedModelId = normalizeMutationModelId(store.getState(), modelId);
      const result = addSlabToStore(editor, anchor, params as SlabInStoreParams);
      return { modelId: normalizedModelId, expressId: result.slabId };
    },
    addBeam(modelId: string, storeyExpressId: number, params: AddBeamInStoreParams): EntityRef {
      const editor = getEditor(modelId);
      const dataStore = resolveDataStore(modelId);
      if (!editor || !dataStore) {
        throw new Error(`bim.store.addBeam: no model loaded for id "${modelId}"`);
      }
      const anchor = resolveSpatialAnchor(dataStore, storeyExpressId);
      const normalizedModelId = normalizeMutationModelId(store.getState(), modelId);
      const result = addBeamToStore(editor, anchor, params as BeamInStoreParams);
      return { modelId: normalizedModelId, expressId: result.beamId };
    },
    addDoor(modelId: string, storeyExpressId: number, params: AddDoorInStoreParams): EntityRef {
      const editor = getEditor(modelId);
      const dataStore = resolveDataStore(modelId);
      if (!editor || !dataStore) throw new Error(`bim.store.addDoor: no model loaded for id "${modelId}"`);
      const anchor = resolveSpatialAnchor(dataStore, storeyExpressId);
      const normalizedModelId = normalizeMutationModelId(store.getState(), modelId);
      const result = addDoorToStore(editor, anchor, params as DoorInStoreParams);
      return { modelId: normalizedModelId, expressId: result.doorId };
    },
    addWindow(modelId: string, storeyExpressId: number, params: AddWindowInStoreParams): EntityRef {
      const editor = getEditor(modelId);
      const dataStore = resolveDataStore(modelId);
      if (!editor || !dataStore) throw new Error(`bim.store.addWindow: no model loaded for id "${modelId}"`);
      const anchor = resolveSpatialAnchor(dataStore, storeyExpressId);
      const normalizedModelId = normalizeMutationModelId(store.getState(), modelId);
      const result = addWindowToStore(editor, anchor, params as WindowInStoreParams);
      return { modelId: normalizedModelId, expressId: result.windowId };
    },
    addSpace(modelId: string, storeyExpressId: number, params: AddSpaceInStoreParams): EntityRef {
      const editor = getEditor(modelId);
      const dataStore = resolveDataStore(modelId);
      if (!editor || !dataStore) throw new Error(`bim.store.addSpace: no model loaded for id "${modelId}"`);
      const anchor = resolveSpatialAnchor(dataStore, storeyExpressId);
      const normalizedModelId = normalizeMutationModelId(store.getState(), modelId);
      const result = addSpaceToStore(editor, anchor, params as SpaceInStoreParams);
      return { modelId: normalizedModelId, expressId: result.spaceId };
    },
    addRoof(modelId: string, storeyExpressId: number, params: AddRoofInStoreParams): EntityRef {
      const editor = getEditor(modelId);
      const dataStore = resolveDataStore(modelId);
      if (!editor || !dataStore) throw new Error(`bim.store.addRoof: no model loaded for id "${modelId}"`);
      const anchor = resolveSpatialAnchor(dataStore, storeyExpressId);
      const normalizedModelId = normalizeMutationModelId(store.getState(), modelId);
      const result = addRoofToStore(editor, anchor, params as RoofInStoreParams);
      return { modelId: normalizedModelId, expressId: result.roofId };
    },
    addPlate(modelId: string, storeyExpressId: number, params: AddPlateInStoreParams): EntityRef {
      const editor = getEditor(modelId);
      const dataStore = resolveDataStore(modelId);
      if (!editor || !dataStore) throw new Error(`bim.store.addPlate: no model loaded for id "${modelId}"`);
      const anchor = resolveSpatialAnchor(dataStore, storeyExpressId);
      const normalizedModelId = normalizeMutationModelId(store.getState(), modelId);
      const result = addPlateToStore(editor, anchor, params as PlateInStoreParams);
      return { modelId: normalizedModelId, expressId: result.plateId };
    },
    addMember(modelId: string, storeyExpressId: number, params: AddMemberInStoreParams): EntityRef {
      const editor = getEditor(modelId);
      const dataStore = resolveDataStore(modelId);
      if (!editor || !dataStore) throw new Error(`bim.store.addMember: no model loaded for id "${modelId}"`);
      const anchor = resolveSpatialAnchor(dataStore, storeyExpressId);
      const normalizedModelId = normalizeMutationModelId(store.getState(), modelId);
      const result = addMemberToStore(editor, anchor, params as MemberInStoreParams);
      return { modelId: normalizedModelId, expressId: result.memberId };
    },
    // Cost / 5D authoring (#4857 PR A). `createCostStoreBackend` resolves the
    // reparent/append/safe-delete bookkeeping from the same `bim.cost` graph
    // the model's cost adapter reads, so a rel authored earlier this session
    // is visible to the very next call. The four CREATE calls push the same
    // undo/redo/dirty/version-bump `addColumn`/etc. push (`pushCreateEntityUndo`,
    // mutation-cost-undo.ts), so a script-authored cost entity is undoable
    // like any other. The other five (`nestCostItems`/`assign*`/
    // `setCostItemValues`/`removeCostEntity`) rewrite or remove EXISTING
    // relationships rather than creating one entity, so they mark dirty and
    // clear the undo/redo stacks instead (`markCostRelationshipMutation`) —
    // see that function's doc comment for why a stack clear, not a real
    // compound undo entry, is what happens here today.
    ...withCostMutationTracking(createCostStoreBackend((modelId: string | undefined) => {
      const requested = modelId ?? '';
      const editor = getEditor(requested);
      const dataStore = resolveDataStore(requested);
      if (!editor || !dataStore) throw new Error(`bim.store: no model loaded for id "${modelId}"`);
      const ownerHistoryId = dataStore.entityIndex.byType.get('IFCOWNERHISTORY')?.[0] ?? null;
      // The PUBLIC id, not `normalizeMutationModelId`'s internal mutation-view
      // alias (`__legacy__`): this feeds `bim.cost.data(modelId)` through
      // `createCostStoreBackend`, and the model's own cost adapter resolves
      // model ids the same way every other `bim.cost` caller does — it does
      // not know the mutation-view alias and would reject it as unknown.
      return { modelId: requested, store: dataStore, editor, ownerHistoryId };
    }, costAdapter), store),
  };
}

/**
 * Wrap every cost-authoring method so the viewer's undo history / dirty flag
 * observes it — see the call site's comment for the two different tails.
 */
function withCostMutationTracking(
  methods: ReturnType<typeof createCostStoreBackend>,
  store: StoreApi,
): ReturnType<typeof createCostStoreBackend> {
  const wrapCreate = <A extends unknown[]>(
    ifcType: string, fn: (...args: A) => EntityRef,
  ) => (...args: A): EntityRef => {
    const ref = fn(...args);
    store.getState().pushCreateEntityUndo(ref.modelId, ref.expressId, ifcType);
    return ref;
  };
  // `modelId` is always the wrapped method's own first argument.
  const wrapRelationshipMutation = <A extends [string, ...unknown[]], R>(
    fn: (...args: A) => R,
  ) => (...args: A): R => {
    const result = fn(...args);
    store.getState().markCostRelationshipMutation(args[0]);
    return result;
  };
  return {
    ...methods,
    addCostSchedule: wrapCreate('IFCCOSTSCHEDULE', methods.addCostSchedule),
    addCostItem: wrapCreate('IFCCOSTITEM', methods.addCostItem),
    addCostValue: wrapCreate('IFCCOSTVALUE', methods.addCostValue),
    addCostQuantity: wrapCreate('IFCPHYSICALSIMPLEQUANTITY', methods.addCostQuantity),
    nestCostItems: wrapRelationshipMutation(methods.nestCostItems),
    assignCostItemsToSchedule: wrapRelationshipMutation(methods.assignCostItemsToSchedule),
    assignToCostItem: wrapRelationshipMutation(methods.assignToCostItem),
    setCostItemValues: wrapRelationshipMutation(methods.setCostItemValues),
    removeCostEntity: wrapRelationshipMutation(methods.removeCostEntity),
  };
}
