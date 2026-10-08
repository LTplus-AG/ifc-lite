/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { ViewerState } from '@/store';
import type { ModelAuthoringPreview } from './model-authoring-preview';

interface Source { modelId: string; store: IfcDataStore | undefined; source: IfcDataStore['source'] | undefined; hash: string | undefined; view: MutablePropertyView | undefined; revision: number | undefined }
const sources = new WeakMap<ModelAuthoringPreview, Source[]>();

/** Copy approval belongs to these loaded sources, never to a later reload with matching names/ids. */
export function captureAuthoringSources(state: ViewerState, preview: ModelAuthoringPreview): void {
  if (!preview.batch.operations.some(op => op.op === 'element.copy' || op.op === 'element.array' || op.op === 'type.detach' || op.op === 'classification.add')) return;
  sources.set(preview, [...state.models].map(([modelId, model]) => ({
    modelId, store: model.ifcDataStore ?? undefined, source: model.ifcDataStore?.source,
    hash: model.sourceContentHash, view: state.mutationViews.get(modelId), revision: state.mutationViews.get(modelId)?.getMutationRevision(),
  })));
}
export function authoringSourcesAreCurrent(state: ViewerState, preview: ModelAuthoringPreview): boolean {
  if (!preview.batch.operations.some(op => op.op === 'element.copy' || op.op === 'element.array' || op.op === 'type.detach' || op.op === 'classification.add')) return true;
  const captured = sources.get(preview);
  return !!captured && captured.length === state.models.size && captured.every(source => {
    const model = state.models.get(source.modelId);
    return !!model && (model.ifcDataStore ?? undefined) === source.store && model.ifcDataStore?.source === source.source
      && model.sourceContentHash === source.hash && state.mutationViews.get(source.modelId) === source.view
      && state.mutationViews.get(source.modelId)?.getMutationRevision() === source.revision;
  });
}
