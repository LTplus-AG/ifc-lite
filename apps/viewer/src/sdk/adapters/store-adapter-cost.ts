/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { createCostStoreBackend, EntityRef } from '@ifc-lite/sdk';
import { attributeNamesForStore, referenceAttributeSlotsForStore } from '@/lib/collab/schema-attribute-names.js';
import { encodeRoomAttributeValue } from '@/lib/collab/entity-reference-wire.js';
import { roomSlotFor } from '@/lib/collab/room-model-target.js';
import { getMutationViewForModel, normalizeMutationModelId } from './mutation-view.js';
import { ensureSourceRoomEntities } from './store-adapter-collab.js';
import type { StoreApi } from './types.js';

type CostMethods = ReturnType<typeof createCostStoreBackend>;

export interface OverlaySnapshot {
  created: ReadonlySet<number>;
  deleted: ReadonlySet<number>;
  positional: ReadonlyMap<number, string>;
}

export function snapshotOverlay(view: MutablePropertyView | null): OverlaySnapshot {
  if (!view) return { created: new Set(), deleted: new Set(), positional: new Map() };
  const positional = new Map<number, string>();
  const ids = new Set([
    ...view.getNewEntities().map(entity => entity.expressId),
    ...view.getMutations().map(mutation => mutation.entityId),
  ]);
  for (const id of ids) {
    const entries = [...(view.getPositionalMutationsForEntity(id) ?? [])];
    if (entries.length > 0) positional.set(id, JSON.stringify(entries));
  }
  return {
    created: new Set(view.getNewEntities().map(entity => entity.expressId)),
    deleted: new Set(view.getTombstones()),
    positional,
  };
}

/**
 * Publish what one cost-authoring call changed in the overlay into a shared
 * room, through the same primitives `bim.store.addEntity` /
 * `setPositionalAttribute` / `removeEntity` use (#5008): new records
 * (schedule, item, value, quantity, and the `IfcRel*` rows the builders
 * author) are materialized with their references, tombstones are mirrored as
 * removals, and rewritten reference slots on existing records are mirrored
 * as attribute edits carrying room paths, never local express ids.
 */
export function mirrorStoreOverlayDelta(
  store: StoreApi,
  modelId: string,
  editor: StoreEditor,
  dataStore: IfcDataStore,
  before: OverlaySnapshot,
  /** Names the surface in the publish failure, e.g. 'cost' or 'structural'. */
  label: string,
): void {
  const state = store.getState();
  const view = getMutationViewForModel(store, modelId);
  if (!view) return;
  const created = view.getNewEntities().map(entity => entity.expressId).filter(id => !before.created.has(id));
  if (created.length > 0 && !ensureSourceRoomEntities(store, modelId, editor, created, dataStore)) {
    throw new Error(`bim.store: the new ${label} entities could not be published to the room`);
  }
  for (const id of view.getTombstones()) {
    if (!before.deleted.has(id)) state.mirrorEntityRemove(modelId, id);
  }
  for (const id of new Set(view.getMutations().map(mutation => mutation.entityId))) {
    if (created.includes(id) || view.isDeleted(id)) continue;
    const positions = view.getPositionalMutationsForEntity(id);
    if (!positions || JSON.stringify([...positions]) === before.positional.get(id)) continue;
    const type = view.getNewEntity(id)?.type ?? dataStore.getEntity?.(id)?.type ?? dataStore.entities.getTypeName(id);
    const names = attributeNamesForStore(dataStore, type);
    const referenceSlots = referenceAttributeSlotsForStore(dataStore, type);
    for (const [index, value] of positions) {
      const name = names[index];
      if (!name) continue;
      state.mirrorAttributeEdit(modelId, id, `bsi::ifc::prop::${name}`,
        encodeRoomAttributeValue(dataStore, value ?? null, referenceSlots[index] ?? false));
    }
  }
}

/**
 * Wrap every cost-authoring method so the viewer's undo history, dirty flag
 * and collaboration room observe it. The four CREATE calls push the same
 * undo/redo/dirty/version-bump tail `addColumn`/etc. push
 * (`pushCreateEntityUndo`, mutation-cost-undo.ts). The other five rewrite or
 * remove EXISTING relationships rather than creating one entity; the backend
 * marks dirty and clears the undo/redo stacks (`markCostRelationshipMutation`)
 * only when a call actually changed the overlay.
 */
/**
 * The collab gate + shared-room mirroring every factory-backed `bim.store`
 * authoring surface needs. Cost (#4857) and structural (#5167) both spread a
 * shared SDK factory into the adapter, which bypasses the `assertCanEdit` and
 * room-publication path the hand-written element methods get — so the wrapper
 * lives here once rather than being re-derived per surface.
 */
export function createStoreMutationTracker(
  store: StoreApi,
  resolve: (modelId: string) => { editor: StoreEditor; dataStore: IfcDataStore } | null,
  label: string,
) {
  // Collab role gate BEFORE the local commit, once here so no method can be
  // added later without it.
  const assertCanEdit = (): void => {
    if (!store.getState().canCollabEdit()) {
      throw new Error('Editing is disabled for your role in this shared session');
    }
  };
  const isSharedRoomModel = (modelId: string): boolean => {
    const state = store.getState();
    return roomSlotFor(state, normalizeMutationModelId(state, modelId)) !== null;
  };
  const tracked = <A extends [string, ...unknown[]], R>(
    fn: (...args: A) => R,
    after: (modelId: string, result: R) => void,
  ) => (...args: A): R => {
    assertCanEdit();
    const modelId = args[0];
    const before = isSharedRoomModel(modelId) ? snapshotOverlay(getMutationViewForModel(store, modelId)) : null;
    const result = fn(...args);
    after(modelId, result);
    if (before) {
      const target = resolve(modelId);
      if (target) mirrorStoreOverlayDelta(store, modelId, target.editor, target.dataStore, before, label);
    }
    return result;
  };
  const create = <A extends [string, ...unknown[]]>(ifcType: string, fn: (...args: A) => EntityRef) =>
    tracked(fn, (_modelId, ref: EntityRef) => store.getState().pushCreateEntityUndo(ref.modelId, ref.expressId, ifcType));
  // The backend itself reports a relationship rewrite only when the overlay
  // actually changed; the wrapper only mirrors.
  const relationship = <A extends [string, ...unknown[]], R>(fn: (...args: A) => R) => tracked(fn, () => {});
  return { create, relationship };
}

export function withCostMutationTracking(
  methods: CostMethods,
  store: StoreApi,
  resolve: (modelId: string) => { editor: StoreEditor; dataStore: IfcDataStore } | null,
): CostMethods {
  const { create, relationship } = createStoreMutationTracker(store, resolve, 'cost');
  return {
    ...methods,
    addCostSchedule: create('IFCCOSTSCHEDULE', methods.addCostSchedule),
    addCostItem: create('IFCCOSTITEM', methods.addCostItem),
    addCostValue: create('IFCCOSTVALUE', methods.addCostValue),
    addCostQuantity: create('IFCPHYSICALSIMPLEQUANTITY', methods.addCostQuantity),
    nestCostItems: relationship(methods.nestCostItems),
    assignCostItemsToSchedule: relationship(methods.assignCostItemsToSchedule),
    assignToCostItem: relationship(methods.assignToCostItem),
    setCostItemValues: relationship(methods.setCostItemValues),
    removeCostEntity: relationship(methods.removeCostEntity),
  };
}
