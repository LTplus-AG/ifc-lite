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
import type { EntityRef, StoreBackendMethods } from '@ifc-lite/sdk';
import type { StoreApi } from './types.js';
import { getModelForRef, LEGACY_MODEL_ID } from './model-compat.js';
import { getOrCreateMutationView, normalizeMutationModelId } from './mutation-view.js';

export function createStoreAdapter(store: StoreApi): StoreBackendMethods {
  // One StoreEditor per (modelId, MutablePropertyView) pair. Editors are
  // cheap, but caching avoids re-scanning the entity index on every call.
  const editors = new WeakMap<object, StoreEditor>();

  function getEditor(modelId: string): StoreEditor | null {
    const state = store.getState();
    const view = getOrCreateMutationView(store, modelId);
    if (!view) return null;
    let editor = editors.get(view);
    if (editor) return editor;

    const refModelId = modelId === 'legacy' ? LEGACY_MODEL_ID : modelId;
    const model = getModelForRef(state, refModelId);
    const dataStore = model?.ifcDataStore;
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
  };
}
