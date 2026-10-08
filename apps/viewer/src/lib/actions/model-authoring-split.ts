/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { iterateEffectiveEntityIds, type StoreEditor, type MutablePropertyView } from '@ifc-lite/mutations';
import { splitElementsInStore } from '@ifc-lite/create';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { ViewerState } from '@/store';
import type { AuthoringOp, ModelAuthoringBatch } from './model-authoring';
import { readSplitSnapshot, sameSplitSnapshot } from './model-authoring-split-state';
import { splitCutInMetres } from './model-authoring-split-params';
import type { ModelAuthoringPreview } from './model-authoring-preview';

type Split = Extract<AuthoringOp, { op: 'element.split' }>;

/** The generic resolver supplies model ownership. This native inventory
 * rejects malformed same-model GUID collisions before assigning effects. */
export function uniqueSplitGuid(store: IfcDataStore, editor: StoreEditor, guid: string): boolean {
  let hits = 0;
  const view = editor.getMutationView();
  for (const { expressId } of iterateEffectiveEntityIds(store, view)) {
    const native = view.getNewEntity(expressId)?.attributes[0] ?? store.entities.getGlobalId(expressId);
    if (native === guid && ++hits > 1) return false;
  }
  return hits === 1;
}

export function writeNativeSplit(batch: ModelAuthoringBatch, op: Split, store: IfcDataStore, editor: StoreEditor, id: number,
  scopes: Parameters<typeof splitElementsInStore>[3] = {}) {
  const current = readSplitSnapshot(store, editor, id, batch.units);
  if (!sameSplitSnapshot(current, op.expected)) throw new Error('The native split source differs from the expected shape or placement');
  return splitElementsInStore(store, editor, [{ expressId: id, cut: splitCutInMetres(op.cut, batch.units) }], scopes)[0];
}

interface SourcePin { modelId: string; store: IfcDataStore | null | undefined; source: Uint8Array | undefined; view: MutablePropertyView | undefined; revision: number | undefined }
const pins = new WeakMap<ModelAuthoringPreview, SourcePin[]>();

/** Approval pins real transport identities and overlay revisions, not counts. */
export function pinSplitSources(state: ViewerState, preview: ModelAuthoringPreview): ModelAuthoringPreview {
  if (!preview.rows.some(row => row.op.op === 'element.split')) return preview;
  const modelIds = new Set(preview.rows.filter(row => row.op.op === 'element.split' && row.modelId).map(row => row.modelId!));
  pins.set(preview, [...modelIds].map(modelId => {
    const store = state.models.get(modelId)?.ifcDataStore, view = state.mutationViews.get(modelId);
    return { modelId, store, source: store?.source, view, revision: view?.getMutationRevision() };
  }));
  return preview;
}

export function splitSourcesCurrent(state: ViewerState, preview: ModelAuthoringPreview): boolean {
  if (!preview.rows.some(row => row.op.op === 'element.split')) return true;
  const saved = pins.get(preview);
  return saved !== undefined && saved.every(pin => {
    const store = state.models.get(pin.modelId)?.ifcDataStore, view = state.mutationViews.get(pin.modelId);
    return store === pin.store && store?.source === pin.source && view === pin.view && view?.getMutationRevision() === pin.revision;
  });
}
