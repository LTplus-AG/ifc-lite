/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Get-or-create a model's `MutablePropertyView` (+ `StoreEditor` where a
 * caller actually WRITES), shared by `drawing-markup-save.ts` and
 * `drawing-markup-restore.ts` (issue #4153's "save into model" UI wiring).
 *
 * Deliberately mirrors `useZoneSpatialZones.ts`'s own `contextFor` rather
 * than the mutation slice's PRIVATE `getOrCreateStoreEditor` (which
 * requires a view to already exist from `PropertiesPanel`'s lazy-init
 * effect and is not exported off `ViewerState`): a self-contained
 * get-or-create is the pattern this codebase already uses for an
 * authoring action that may run before the properties panel has ever
 * mounted.
 *
 * Two entry points, not one, because restore-on-load runs unconditionally
 * on every model mount (`useDrawingMarkupRestoreOnLoad`) while save only
 * runs from an explicit button click. `StoreEditor`'s constructor walks
 * `store.entityIndex.byId` (`computeMaxExistingId`) — real parsed models
 * always have this, but the read-only path must not require it: several
 * existing component tests seed a deliberately partial `IfcDataStore` stub
 * (only the fields THAT test needs) as `activeModelId`'s model, and
 * restore-on-load reaching every one of those on mount previously crashed
 * `measure-parity.test.tsx` (`Cannot read properties of undefined (reading
 * 'byId')`) by constructing a `StoreEditor` it never needed just to READ.
 */

import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { configureMutationView } from '@/utils/configureMutationView';

export interface DrawingMarkupReadContext {
  view: MutablePropertyView;
  dataStore: IfcDataStore;
}

export interface DrawingMarkupModelContext extends DrawingMarkupReadContext {
  editor: StoreEditor;
}

/**
 * Resolve `modelId`'s data store and get-or-create its `MutablePropertyView`
 * (registered on the store so the rest of the app — the mutation-version
 * badge, `ExportChangesButton`'s `collectChangedModels` — sees the same
 * instance). No `StoreEditor` is constructed. Returns `null` when the model
 * or its data store cannot be found.
 */
export function getDrawingMarkupReadContext(modelId: string): DrawingMarkupReadContext | null {
  const state = useViewerStore.getState();
  const model = state.models.get(modelId);
  const dataStore = (model?.ifcDataStore ?? (modelId === 'legacy' ? state.ifcDataStore : null)) as IfcDataStore | null;
  if (!dataStore) return null;

  let view = state.getMutationView(modelId);
  if (!view) {
    view = new MutablePropertyView(dataStore.properties || null, modelId);
    configureMutationView(view, dataStore);
    state.registerMutationView(modelId, view);
  }

  return { view, dataStore };
}

/**
 * {@link getDrawingMarkupReadContext}, plus a get-or-create `StoreEditor`
 * (cached on `state.storeEditors`, same cache every other authoring action
 * shares) — for a caller that actually WRITES overlay entities.
 */
export function getDrawingMarkupModelContext(modelId: string): DrawingMarkupModelContext | null {
  const read = getDrawingMarkupReadContext(modelId);
  if (!read) return null;
  const state = useViewerStore.getState();

  let editor = state.storeEditors.get(modelId);
  if (!editor) {
    editor = new StoreEditor(read.dataStore, read.view);
    state.storeEditors.set(modelId, editor);
  }

  return { ...read, editor };
}
