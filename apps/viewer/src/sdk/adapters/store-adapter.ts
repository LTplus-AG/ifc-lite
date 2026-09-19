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
import type { IfcDataStore } from '@ifc-lite/parser';
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
import { attributeNamesForStore, referenceAttributeSlotsForStore } from '@/lib/collab/schema-attribute-names.js';
import { encodeRoomAttributeValue, referencedExpressIds } from '@/lib/collab/entity-reference-wire.js';
import { entityForPath, pathForGuid } from '@/lib/collab/entity-paths.js';
import { ensureSourceRoomEntities, initialRoomAttributes } from './store-adapter-collab.js';

export function createStoreAdapter(store: StoreApi): StoreBackendMethods {
  // One StoreEditor per (modelId, MutablePropertyView) pair. Editors are
  // cheap, but caching avoids re-scanning the entity index on every call.
  const editors = new WeakMap<object, StoreEditor>();
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

  function assertCanEdit(operation: string): void {
    if (!store.getState().canCollabEdit()) {
      throw new Error(`bim.store.${operation}: collaboration is read-only for this participant`);
    }
  }

  function mirrorCreatedEntity(
    modelId: string,
    editor: StoreEditor,
    expressId: number,
    dataStore: IfcDataStore,
  ): void {
    const entity = editor.getNewEntity(expressId);
    if (!entity) return;
    const names = attributeNamesForStore(dataStore, entity.type);
    const guid = names[0] === 'GlobalId' && typeof entity.attributes[0] === 'string'
      ? entity.attributes[0]
      : `ifc-lite-store-${crypto.randomUUID()}`;
    const state = store.getState();
    state.mirrorEntityCreate(
      modelId,
      expressId,
      entity.type,
      guid,
      null,
      initialRoomAttributes(dataStore, entity.type, names, entity.attributes),
    );
  }

  function assertAvailableGlobalId(
    operation: string, modelId: string, editor: StoreEditor, dataStore: IfcDataStore, expressId: number, globalId: string,
  ): void {
    const sourceOwner = dataStore.entities.getExpressIdByGlobalId(globalId);
    const roomOwner = entityForPath(dataStore, pathForGuid(dataStore, globalId));
    const localOwner = editor.getNewEntities().find((entity) => {
      const names = attributeNamesForStore(dataStore, entity.type);
      return names[0] === 'GlobalId' && entity.attributes[0] === globalId;
    })?.expressId;
    if ((sourceOwner >= 0 && sourceOwner !== expressId && editor.hasEntity(sourceOwner))
      || (roomOwner !== null && roomOwner !== expressId && editor.hasEntity(roomOwner))
      || (localOwner !== undefined && localOwner !== expressId)) {
      throw new Error(`bim.store.${operation}: GlobalId "${globalId}" already exists in model "${modelId}"`);
    }
  }

  return {
    addEntity(modelId: string, def: { type: string; attributes: unknown[] }): EntityRef {
      assertCanEdit('addEntity');
      const normalizedId = normalizeMutationModelId(store.getState(), modelId);
      const editor = getEditor(modelId);
      if (!editor) {
        throw new Error(`bim.store.addEntity: no model loaded for id "${modelId}"`);
      }
      const dataStore = resolveDataStore(modelId);
      if (!dataStore) {
        throw new Error(`bim.store.addEntity: no model loaded for id "${modelId}"`);
      }
      const names = attributeNamesForStore(dataStore, def.type);
      const globalId = names[0] === 'GlobalId' && typeof def.attributes[0] === 'string'
        ? def.attributes[0]
        : null;
      if (globalId) assertAvailableGlobalId('addEntity', modelId, editor, dataStore, -1, globalId);
      const referenceSlots = referenceAttributeSlotsForStore(dataStore, def.type);
      const referenced = new Set<number>();
      def.attributes.forEach((value, index) => referencedExpressIds(
        value, referenceSlots[index] ?? false, referenced,
      ));
      ensureSourceRoomEntities(store, modelId, editor, referenced, dataStore);
      const ref = editor.addEntity(def.type, def.attributes as Parameters<StoreEditor['addEntity']>[1]);
      mirrorCreatedEntity(modelId, editor, ref.expressId, dataStore);
      return { modelId: normalizedId, expressId: ref.expressId };
    },
    removeEntity(ref: EntityRef): boolean {
      assertCanEdit('removeEntity');
      const editor = getEditor(ref.modelId);
      if (!editor) return false;
      const dataStore = resolveDataStore(ref.modelId);
      if (!dataStore) return false;
      const roomEntityReady = ensureSourceRoomEntities(store, ref.modelId, editor, [ref.expressId], dataStore);
      const removed = editor.removeEntity(ref.expressId);
      if (removed && roomEntityReady) {
        store.getState().mirrorEntityRemove(ref.modelId, ref.expressId);
      }
      return removed;
    },
    setPositionalAttribute(ref: EntityRef, index: number, value: unknown): void {
      assertCanEdit('setPositionalAttribute');
      const editor = getEditor(ref.modelId);
      if (!editor) {
        throw new Error(`bim.store.setPositionalAttribute: no model loaded for id "${ref.modelId}"`);
      }
      const dataStore = resolveDataStore(ref.modelId);
      const type = editor.getNewEntity(ref.expressId)?.type
        ?? dataStore?.getEntity?.(ref.expressId)?.type
        ?? dataStore?.entities.getTypeName(ref.expressId);
      const name = type && dataStore ? attributeNamesForStore(dataStore, type)[index] : undefined;
      if (name === 'GlobalId') {
        throw new Error('bim.store.setPositionalAttribute: GlobalId is immutable in a shared room');
      }
      let roomReferencesReady = true;
      if (dataStore) {
        const referenced = referencedExpressIds(
          value, type ? (referenceAttributeSlotsForStore(dataStore, type)[index] ?? false) : false,
        );
        referenced.add(ref.expressId);
        roomReferencesReady = ensureSourceRoomEntities(store, ref.modelId, editor, referenced, dataStore);
      }
      editor.setPositionalAttribute(ref.expressId, index, value as Parameters<StoreEditor['setPositionalAttribute']>[2]);
      if (name && roomReferencesReady) {
        store.getState().mirrorAttributeEdit(
          ref.modelId,
          ref.expressId,
          `bsi::ifc::prop::${name}`,
          dataStore ? encodeRoomAttributeValue(
            dataStore, value ?? null,
            type ? (referenceAttributeSlotsForStore(dataStore, type)[index] ?? false) : false,
          ) : value ?? null,
        );
      }
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
  };
}
