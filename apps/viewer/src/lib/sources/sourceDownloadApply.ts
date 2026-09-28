/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the source-download listener does to the STORE once an item's bytes
 * have loaded: name it, tag it, and — for "Open (replace)" — retire the model
 * it supersedes.
 *
 * Extracted from `ViewportContainer`'s listener rather than written inside it
 * — the listener lives in a 1,200-line component with a WebGPU viewport, and
 * none of that is needed to decide what carries over.
 *
 * The ORDER here is load-bearing and is the same order `syncSourceModel`
 * uses: the replacement is already registered when this is called, so a load
 * that failed has left the user's model exactly where it was.
 *
 * What carries over, and why each one:
 *  - the user's model TAGS, which name the outgoing model id and would
 *    otherwise die with it (#4215);
 *  - the ACTIVE model, when it was the one being replaced;
 *  - the SELECTION, by GlobalId rather than express id — see
 *    `lib/history/carryOverSelection.ts`;
 *  - the History panel's focus, so the timeline keeps showing this model
 *    rather than falling back to "open a model".
 */

import { captureSelection, resolveCarriedSelection, type CarriedSelection } from '@/lib/history/carryOverSelection';
import { captureModelTags, restoreModelTags } from '@/lib/model-tags/carry-over';
import type { SourceDownloadItem } from '@/services/sources/source-host';
import type { SourceHost } from '@/services/sources/source-host';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';

/**
 * How one downloaded item presents: which provider it came from, and what to
 * call the model.
 *
 * `safeName` is the caller's already-sanitized file name — provider-supplied
 * names are untrusted input reaching a filename position, and sanitizing it
 * twice in two places is how the two spellings drift.
 */
export function describeDownloadItem(
  item: SourceDownloadItem,
  sourceHost: SourceHost | null,
  safeName: string,
): { readonly providerTitle: string; readonly modelName: string } {
  const providerName = item.tag?.provider ?? item.commit?.provider ?? 'source';
  return {
    providerTitle: sourceHost?.get(providerName)?.manifest.title ?? providerName,
    // A commit opened alongside carries its own label; three copies of
    // `structural.ifc` in the model list are indistinguishable.
    modelName: item.displayName ?? safeName,
  };
}

/**
 * Reads what must be captured BEFORE the replacement loads: the outgoing
 * model's list placement, and the selection as a key.
 *
 * Both are gone by the time the swap runs — `removeModel` has taken the model
 * with them — so capturing late would silently carry nothing.
 */
export function captureModelSwap(replacedModelId: string | undefined): {
  readonly placement?: { loadedAt: number; visible: boolean; collapsed: boolean };
  readonly selection: CarriedSelection | null;
} {
  if (!replacedModelId) return { selection: null };
  const state = useViewerStore.getState();
  const previous = state.models.get(replacedModelId);
  return {
    ...(previous
      ? { placement: { loadedAt: previous.loadedAt, visible: previous.visible, collapsed: previous.collapsed } }
      : {}),
    selection: captureSelection(previous, state.selectedEntity?.expressId ?? null),
  };
}

/** Retires `replacedModelId` in favour of `modelId`. No-op when there is nothing to replace. */
export function swapLoadedModel(
  replacedModelId: string | undefined,
  modelId: string,
  carried: CarriedSelection | null,
): void {
  if (!replacedModelId || replacedModelId === modelId) return;
  const state = useViewerStore.getState();
  if (!state.models.has(replacedModelId)) return;

  const wasActive = state.activeModelId === replacedModelId;
  restoreModelTags(state, captureModelTags(state, [replacedModelId]), replacedModelId, modelId);
  state.removeModel(replacedModelId);

  const post = useViewerStore.getState();
  if (wasActive) post.setActiveModel(modelId);
  post.setHistoryFocus(modelId);

  const expressId = resolveCarriedSelection(post.models.get(modelId), carried);
  if (expressId === null) return;
  // Two-channel selection (AGENTS.md): the global id drives the 3D highlight,
  // the {modelId, expressId} ref drives the properties panel. Both, or
  // highlighting silently breaks.
  post.setSelectedEntityIds([]);
  post.setSelectedEntityId(toGlobalIdFromModels(post.models, modelId, expressId));
  post.setSelectedEntity({ modelId, expressId });
}

/**
 * Everything that happens after `addModel` reports the replacement
 * registered: tags, the downloaded-file record, and the swap.
 *
 * The ORDER is load-bearing — the swap runs LAST, so a load that failed has
 * left the user's model exactly where it was. Same order `syncSourceModel`
 * uses, for the same reason.
 */
export function applyDownloadedModel(
  item: SourceDownloadItem,
  modelId: string,
  swap: ReturnType<typeof captureModelSwap>,
  recordDownload: (item: SourceDownloadItem) => void,
): void {
  const state = useViewerStore.getState();
  if (item.tag) state.setSourceTag(modelId, item.tag);
  if (item.commit) state.setCommitTag(modelId, item.commit);
  if (item.tag && item.sourceFile) recordDownload(item);
  swapLoadedModel(item.replaceModelId, modelId, swap.selection);
}
