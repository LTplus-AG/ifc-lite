/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { MAX_CAPTURED_SCOPE_MEMBERS, resolveCapturedEntityScope, type CapturedEntityScope } from '@ifc-lite/rules';
import type { ViewerState } from '@/store';
import { getBasketSelectionRefsFromStore, getVisibleBasketEntityRefsFromStore, invalidateVisibleBasketCache } from '@/store/basketVisibleSet';
import { evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';

/** Capture native selection expansion or current visibility once, with the
 * source identity the canonical load path already computed. No GUID guesses,
 * new ingest path, full-source rehash, or visibility feedback after creation. */
export function captureArtifactScope(mode: CapturedEntityScope['mode'], state: ViewerState): CapturedEntityScope {
  if (mode === 'visible') invalidateVisibleBasketCache();
  const refs = mode === 'selected' ? getBasketSelectionRefsFromStore(state) : getVisibleBasketEntityRefsFromStore(false, state);
  if (refs.length === 0) throw new Error(`There are no ${mode} elements to capture. Select or show elements and try again.`);
  if (refs.length > MAX_CAPTURED_SCOPE_MEMBERS) throw new Error(`Capture at most ${MAX_CAPTURED_SCOPE_MEMBERS.toLocaleString()} elements. Narrow the selection or visible population first.`);
  const sources = new Map<string, CapturedEntityScope['sources'][number]>();
  const creationsByModel = new Map<string, Map<number, string>>();
  for (const ref of refs) {
    const model = state.models.get(ref.modelId);
    if (!model?.sourceFingerprint || !model.sourceContentHash) throw new Error('The original file identity is unavailable. Reload that file before capturing its elements.');
    let source = sources.get(ref.modelId);
    if (!source) {
      source = { sourceFingerprint: model.sourceFingerprint, sourceContentHash: model.sourceContentHash, members: [] };
      sources.set(ref.modelId, source);
    }
    const view = state.mutationViews.get(ref.modelId);
    let creationId: string | undefined;
    if (view?.getNewEntity(ref.expressId)) {
      let creations = creationsByModel.get(ref.modelId);
      if (!creations) {
        creations = new Map(view.getMutations().filter(m => m.type === 'CREATE_ENTITY').map(m => [m.entityId, m.id]));
        creationsByModel.set(ref.modelId, creations);
      }
      creationId = creations.get(ref.expressId);
      if (!creationId) throw new Error('An authored element has no recoverable creation identity. Capture after restoring its original edit history.');
    }
    source.members.push({ expressId: ref.expressId, ...(creationId ? { creationId } : {}) });
  }
  const scope: CapturedEntityScope = { version: 1, mode, capturedAt: Date.now(), sources: [...sources.values()] };
  resolveCapturedEntityScope(scope, evaluatorModelsFromState(state));
  return scope;
}

/** The product describes the population; internal hash and journal formats
 * belong to persisted schema documentation, not the caption. */
export function capturedScopeCaption(scope: CapturedEntityScope): string {
  const count = scope.sources.reduce((total, source) => total + source.members.length, 0);
  return `${count.toLocaleString()} ${scope.mode} elements captured from ${scope.sources.length} file${scope.sources.length === 1 ? '' : 's'}`;
}
