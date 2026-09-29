/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Type objects, materials and layer sets written as ordinary undo history
 * (charter #6232, M2.5).
 *
 * `bim.store`'s modelling methods (`createModellingStoreBackend`) validate
 * and write through the `@ifc-lite/create` builders, but the script adapter
 * clears the undo history after a relationship write, because it has no
 * command to hang one undo step on. The Model workspace has one: a
 * transaction. So here the same methods run against the model's live editor
 * inside `runAtomic` (all or nothing), and every overlay record they wrote
 * (a created type, a rewritten or removed `IfcRel*`) is appended to the undo
 * stack. The surrounding transaction tags the lot as one step.
 *
 * An `IfcRel*` created earlier this session that an assignment empties is
 * forgotten by the overlay; its record is stashed so undo can put it back.
 * In a shared room the overlay delta is published like the script path does.
 */

import type { StoreApi } from 'zustand';
import { MutablePropertyView, StoreEditor, type Mutation, type NewEntity } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { readRelatedLists } from '@ifc-lite/create';
import { createModellingStoreBackend, resolveLiveOwnerHistoryId } from '@ifc-lite/sdk';
import { roomSlotFor } from '@/lib/collab/room-model-target';
import { mirrorStoreOverlayDelta, snapshotOverlay } from '@/sdk/adapters/store-adapter-cost';
import { configureMutationView } from '@/utils/configureMutationView';
import type { ViewerState } from '../index.js';

export type ModellingMethods = ReturnType<typeof createModellingStoreBackend>;
export type ModellingStore = Pick<StoreApi<ViewerState>, 'getState' | 'setState' | 'subscribe'>;

export interface ModelEditTarget {
  readonly modelId: string;
  readonly dataStore: IfcDataStore;
  readonly view: MutablePropertyView;
  readonly editor: StoreEditor;
}

/** A model's parsed data, its mutation view and the store's cached editor, created on first use. */
export function modelEditTarget(state: ViewerState, modelId: string): ModelEditTarget | null {
  const dataStore = state.models.get(modelId)?.ifcDataStore;
  if (!dataStore) return null;
  let view = state.mutationViews.get(modelId);
  if (!view) {
    view = new MutablePropertyView(dataStore.properties || null, modelId);
    configureMutationView(view, dataStore);
    state.registerMutationView(modelId, view);
  }
  let editor = state.storeEditors.get(modelId);
  if (!editor) {
    editor = new StoreEditor(dataStore, view);
    // A non-reactive cache, shared with the mutation slice (see its getOrCreateStoreEditor).
    state.storeEditors.set(modelId, editor);
  }
  return { modelId, dataStore, view, editor };
}

/**
 * Run `edit` against `modelId`'s modelling methods and record what it wrote
 * as undo history. Throws (writing nothing) when the model is not loaded or
 * a method refuses its input.
 */
export function recordModellingEdit<T>(
  store: ModellingStore,
  modelId: string,
  edit: (methods: ModellingMethods, draft: StoreEditor) => T,
): T {
  const state = store.getState();
  const target = modelEditTarget(state, modelId);
  if (!target) throw new Error(`No model loaded for id "${modelId}"`);
  const { dataStore, view, editor } = target;
  const room = roomSlotFor(state, modelId) ? snapshotOverlay(view) : null;
  // By id, not by length: forgetting an overlay record also drops its own
  // earlier history entries from the view.
  const seen = new Set(view.getMutations().map((m) => m.id));
  const overlayBefore = new Map(view.getNewEntities().map((e) => [e.expressId, e]));

  const result = editor.runAtomic((draft) => edit(createModellingStoreBackend(() => ({
    modelId,
    store: dataStore,
    editor: draft,
    mutationView: draft.getMutationView(),
    ownerHistoryId: resolveLiveOwnerHistoryId(dataStore, draft, draft.getMutationView()),
  })), draft));

  const written = view.getMutations().filter((m) => !seen.has(m.id));
  stashForgottenRecords(store, modelId, written, overlayBefore);
  store.getState().recordMutationBatch(modelId, written);
  if (room) mirrorStoreOverlayDelta(store, modelId, editor, dataStore, room, 'modelling');
  return result;
}

/**
 * Take `objectIds` out of whatever IfcRelDefinesByType types them ("No
 * type"). A relationship left with no object is removed, as an assignment
 * that moves its last object does (`relateOneToManyInStore`).
 */
export function detachFromType(draft: StoreEditor, dataStore: IfcDataStore, objectIds: readonly number[]): void {
  const leaving = new Set(objectIds);
  for (const rel of readRelatedLists(dataStore, 'IfcRelDefinesByType', draft.getMutationView())) {
    if (!rel.relatedIds.some((id) => leaving.has(id))) continue;
    const remaining = rel.relatedIds.filter((id) => !leaving.has(id));
    if (remaining.length === 0) draft.removeEntity(rel.relId);
    else draft.setPositionalAttribute(rel.relId, 4, remaining.map((id) => `#${id}`));
  }
}

/** Undo of a DELETE_ENTITY restores an overlay-created record from `removedNewEntities`. */
function stashForgottenRecords(
  store: ModellingStore,
  modelId: string,
  written: readonly Mutation[],
  overlayBefore: ReadonlyMap<number, NewEntity>,
): void {
  const forgotten = written
    .filter((m) => m.type === 'DELETE_ENTITY' && overlayBefore.has(m.entityId))
    .map((m) => [`${modelId}:${m.entityId}`, overlayBefore.get(m.entityId)!] as const);
  if (forgotten.length === 0) return;
  store.setState((s) => ({ removedNewEntities: new Map([...s.removedNewEntities, ...forgotten]) }));
}
