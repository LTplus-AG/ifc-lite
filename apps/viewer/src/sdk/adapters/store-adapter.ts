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
  type SpatialAnchor,
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
import { createCostStoreBackend, createStructuralStoreBackend, resolveLiveOwnerHistoryId } from '@ifc-lite/sdk';
import type { StoreApi } from './types.js';
import { getModelForRef, LEGACY_MODEL_ID } from './model-compat.js';
import { createCostAdapter } from './cost-adapter.js';
import { withCostMutationTracking } from './store-adapter-cost.js';
import { withStructuralMutationTracking } from './store-adapter-structural.js';
import { getMutationViewForModel, getOrCreateMutationView, isLegacyMutationRef, normalizeMutationModelId } from './mutation-view.js';
import { attributeNamesForStore, referenceAttributeSlotsForStore } from '@/lib/collab/schema-attribute-names.js';
import type { AuthoredElement } from '../../store/slices/mutationSlice.js';
import { encodeRoomAttributeValue, referencedExpressIds } from '@/lib/collab/entity-reference-wire.js';
import { entityForPath, pathForGuid } from '@/lib/collab/entity-paths.js';
import { ensureSourceRoomEntities, initialRoomAttributes } from './store-adapter-collab.js';
import { roomSlotFor } from '@/lib/collab/room-model-target.js';

export function createStoreAdapter(store: StoreApi): StoreBackendMethods {
  // One StoreEditor per (modelId, MutablePropertyView) pair. Editors are
  // cheap, but caching avoids re-scanning the entity index on every call.
  const editors = new WeakMap<object, StoreEditor>();
  const costAdapter = createCostAdapter(store);
  function resolveDataStore(modelId: string) {
    const state = store.getState();
    // The refs this adapter hands out carry the mutation-view alias
    // (`__legacy__`) in single-model mode; they must resolve back here.
    const refModelId = isLegacyMutationRef(state, modelId) ? LEGACY_MODEL_ID : modelId;
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

  function isSharedRoomModel(modelId: string): boolean {
    const state = store.getState();
    return roomSlotFor(state, normalizeMutationModelId(state, modelId)) !== null;
  }

  function mirrorCreatedEntity(
    modelId: string,
    editor: StoreEditor,
    expressId: number,
    dataStore: IfcDataStore,
  ): void {
    if (!isSharedRoomModel(modelId)) return;
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
    const view = getMutationViewForModel(store, modelId);
    // Reconstructed IFCX stores intentionally have an empty STEP entity index;
    // their real membership lives behind getEntity(). StoreEditor.hasEntity()
    // therefore cannot be the sole liveness oracle for a room-path owner.
    const isLive = (owner: number): boolean => !view?.isDeleted(owner)
      && (editor.hasEntity(owner) || dataStore.getEntity?.(owner) != null);
    const localOwner = editor.getNewEntities().find((entity) => {
      const names = attributeNamesForStore(dataStore, entity.type);
      return names[0] === 'GlobalId' && entity.attributes[0] === globalId;
    })?.expressId;
    if ((sourceOwner >= 0 && sourceOwner !== expressId && isLive(sourceOwner))
      || (roomOwner !== null && roomOwner !== expressId && isLive(roomOwner))
      || (localOwner !== undefined && localOwner !== expressId)) {
      throw new Error(`bim.store.${operation}: GlobalId "${globalId}" already exists in model "${modelId}"`);
    }
  }

  /**
   * Run one `@ifc-lite/create` in-store builder. In a shared room every entity
   * the builder created (element, placement, profile, representation, and its
   * containment rel) is published exactly like `addEntity` publishes a single
   * record; the next recipient reconstruct replaces the local overlay with the
   * room document, so anything left unmirrored would be lost (#5008).
   */
  function buildElement(
    operation: string,
    modelId: string,
    storeyExpressId: number,
    element: AuthoredElement,
    build: (editor: StoreEditor, anchor: SpatialAnchor) => number,
  ): EntityRef {
    assertCanEdit(operation);
    const editor = getEditor(modelId);
    const dataStore = resolveDataStore(modelId);
    if (!editor || !dataStore) {
      throw new Error(`bim.store.${operation}: no model loaded for id "${modelId}"`);
    }
    const normalizedModelId = normalizeMutationModelId(store.getState(), modelId);
    const anchor = resolveSpatialAnchor(dataStore, storeyExpressId, store.getState().getMutationView(normalizedModelId));
    // Only a shared room needs the before/after diff; outside one, an O(n)
    // snapshot per element made bulk authoring quadratic (#5413).
    const shared = isSharedRoomModel(modelId);
    const before = shared ? new Set(editor.getNewEntities().map((entity) => entity.expressId)) : null;
    const expressId = build(editor, anchor);
    if (before) {
      const created = editor.getNewEntities()
        .map((entity) => entity.expressId)
        .filter((id) => !before.has(id));
      if (!ensureSourceRoomEntities(store, modelId, editor, created, dataStore)) {
        throw new Error(`bim.store.${operation}: the new entities could not be published to the room`);
      }
    }
    // The builder only wrote the overlay. Book it the way the UI's add actions
    // do — mesh, spatial tree, undo entry, `mutationVersion` — or the element
    // is in the export and nowhere else: a flow or script "adds" columns the
    // user never sees.
    store.getState().recordAuthoredElement?.(normalizedModelId, storeyExpressId, expressId, element);
    return { modelId: normalizedModelId, expressId };
  }

  /**
   * One per-call resolution shared by the cost and structural store factories
   * (#5167 S.1). Extracted rather than duplicated: two copies would drift on
   * the mutation-view lookup, and both surfaces must resolve the same editor
   * for entities authored in one to be visible to the other.
   */
  const resolveStoreModel = (modelId: string | undefined) => {
    const requested = modelId ?? '';
    const editor = getEditor(requested);
    const dataStore = resolveDataStore(requested);
    if (!editor || !dataStore) throw new Error(`bim.store: no model loaded for id "${modelId}"`);
    const normalized = normalizeMutationModelId(store.getState(), requested);
    const mutationView = store.getState().getMutationView(normalized);
    if (!mutationView) throw new Error(`bim.store: no mutation view for model id "${modelId}"`);
    const ownerHistoryId = resolveLiveOwnerHistoryId(dataStore, editor, mutationView);
    // #5234: the NORMALIZED id, matching what `addEntity`/`buildElement`
    // return. `entityRefToString` serializes `modelId` verbatim, so handing
    // back the caller's raw spelling meant the same entity could serialize
    // under two different keys depending on which store method minted its ref.
    return { modelId: normalized, store: dataStore, editor, mutationView, ownerHistoryId };
  };

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
      if (isSharedRoomModel(modelId)) {
        const referenceSlots = referenceAttributeSlotsForStore(dataStore, def.type);
        const referenced = new Set<number>();
        def.attributes.forEach((value, index) => referencedExpressIds(
          value, referenceSlots[index] ?? false, referenced,
        ));
        ensureSourceRoomEntities(store, modelId, editor, referenced, dataStore);
      }
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
      const shared = isSharedRoomModel(ref.modelId);
      const roomEntityReady = !shared
        || ensureSourceRoomEntities(store, ref.modelId, editor, [ref.expressId], dataStore);
      // StoreEditor deliberately validates STEP membership through
      // entityIndex.byId, which is empty for reconstructed IFCX stores.
      // Those base entities are real and deletable through getEntity().
      const view = getMutationViewForModel(store, ref.modelId);
      // Captured before the removal forgets it, so undo can re-add it.
      const overlayRecord = view?.getNewEntity(ref.expressId);
      const removed = view !== null
        && !view.isDeleted(ref.expressId)
        && editor.getNewEntity(ref.expressId) === null
        && dataStore.getEntity?.(ref.expressId) != null
        ? view.deleteEntity(ref.expressId)
        : editor.removeEntity(ref.expressId);
      if (removed) {
        store.getState().recordEntityRemoval?.(normalizeMutationModelId(store.getState(), ref.modelId), ref.expressId, overlayRecord);
      }
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
      const shared = isSharedRoomModel(ref.modelId);
      if (name === 'GlobalId' && shared) {
        throw new Error('bim.store.setPositionalAttribute: GlobalId is immutable in a shared room');
      }
      let roomReferencesReady = true;
      if (dataStore && shared) {
        const referenced = referencedExpressIds(
          value, type ? (referenceAttributeSlotsForStore(dataStore, type)[index] ?? false) : false,
        );
        referenced.add(ref.expressId);
        roomReferencesReady = ensureSourceRoomEntities(
          store, ref.modelId, editor, referenced, dataStore,
          {
            expressId: ref.expressId,
            index,
            value: value as Parameters<StoreEditor['setPositionalAttribute']>[2],
          },
        );
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
      return buildElement('addColumn', modelId, storeyExpressId, { kind: 'column', params: params as ColumnInStoreParams },
        (editor, anchor) => addColumnToStore(editor, anchor, params as ColumnInStoreParams).columnId);
    },
    addWall(modelId: string, storeyExpressId: number, params: AddWallInStoreParams): EntityRef {
      return buildElement('addWall', modelId, storeyExpressId, { kind: 'wall', params: params as WallInStoreParams },
        (editor, anchor) => addWallToStore(editor, anchor, params as WallInStoreParams).wallId);
    },
    addSlab(modelId: string, storeyExpressId: number, params: AddSlabInStoreParams): EntityRef {
      return buildElement('addSlab', modelId, storeyExpressId, { kind: 'slab', params: params as SlabInStoreParams },
        (editor, anchor) => addSlabToStore(editor, anchor, params as SlabInStoreParams).slabId);
    },
    addBeam(modelId: string, storeyExpressId: number, params: AddBeamInStoreParams): EntityRef {
      return buildElement('addBeam', modelId, storeyExpressId, { kind: 'beam', params: params as BeamInStoreParams },
        (editor, anchor) => addBeamToStore(editor, anchor, params as BeamInStoreParams).beamId);
    },
    addDoor(modelId: string, storeyExpressId: number, params: AddDoorInStoreParams): EntityRef {
      return buildElement('addDoor', modelId, storeyExpressId, { kind: 'door', params: params as DoorInStoreParams },
        (editor, anchor) => addDoorToStore(editor, anchor, params as DoorInStoreParams).doorId);
    },
    addWindow(modelId: string, storeyExpressId: number, params: AddWindowInStoreParams): EntityRef {
      return buildElement('addWindow', modelId, storeyExpressId, { kind: 'window', params: params as WindowInStoreParams },
        (editor, anchor) => addWindowToStore(editor, anchor, params as WindowInStoreParams).windowId);
    },
    addSpace(modelId: string, storeyExpressId: number, params: AddSpaceInStoreParams): EntityRef {
      return buildElement('addSpace', modelId, storeyExpressId, { kind: 'space', params: params as SpaceInStoreParams },
        (editor, anchor) => addSpaceToStore(editor, anchor, params as SpaceInStoreParams).spaceId);
    },
    addRoof(modelId: string, storeyExpressId: number, params: AddRoofInStoreParams): EntityRef {
      return buildElement('addRoof', modelId, storeyExpressId, { kind: 'roof', params: params as RoofInStoreParams },
        (editor, anchor) => addRoofToStore(editor, anchor, params as RoofInStoreParams).roofId);
    },
    addPlate(modelId: string, storeyExpressId: number, params: AddPlateInStoreParams): EntityRef {
      return buildElement('addPlate', modelId, storeyExpressId, { kind: 'plate', params: params as PlateInStoreParams },
        (editor, anchor) => addPlateToStore(editor, anchor, params as PlateInStoreParams).plateId);
    },
    addMember(modelId: string, storeyExpressId: number, params: AddMemberInStoreParams): EntityRef {
      return buildElement('addMember', modelId, storeyExpressId, { kind: 'member', params: params as MemberInStoreParams },
        (editor, anchor) => addMemberToStore(editor, anchor, params as MemberInStoreParams).memberId);
    },
    ...withCostMutationTracking(createCostStoreBackend(resolveStoreModel, costAdapter, modelId => store.getState().markCostRelationshipMutation(modelId)), store, (modelId) => {
      const editor = getEditor(modelId);
      const dataStore = resolveDataStore(modelId);
      return editor && dataStore ? { editor, dataStore } : null;
    }),
    // Structural authoring (#5167 S.1). Same shared resolver as cost, so an
    // entity authored through either surface is visible to the other, and the
    // same collab gate + room mirroring — spreading the factory raw would let
    // a read-only participant mutate the local overlay and would leave the
    // authored entities unpublished in a shared room.
    ...withStructuralMutationTracking(createStructuralStoreBackend(resolveStoreModel), store, (modelId) => {
      const editor = getEditor(modelId);
      const dataStore = resolveDataStore(modelId);
      return editor && dataStore ? { editor, dataStore } : null;
    }),
  };
}
