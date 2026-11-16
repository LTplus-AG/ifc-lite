/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ListDefinition } from '@ifc-lite/lists';
import { useViewerStore } from '@/store';
import { captureAnalysisStamp } from '@/hooks/useAnalysisStaleness';
import { resolveRenderFrame } from '@/hooks/useRenderFrameOffsets';
import { evaluatorModelsFromState } from '../model-tags/evaluator-models';
import { prepareListProviders } from './prepare-providers';
import { runListFederated, type ModelProviderPair } from './run-list';
import { captureListRunModels, recordListRun } from './run-provenance';

/** The Lists panel and automation await the same engine and retain identical provenance. */
export async function executeNativeList(definition: ListDefinition, options: {
  pairs?: readonly ModelProviderPair[]; signal?: AbortSignal; checkpoint?: () => void; legacyName?: string;
} = {}) {
  options.signal?.throwIfAborted(); options.checkpoint?.();
  const state = useViewerStore.getState();
  const pairs = options.pairs ?? prepareListProviders(state, resolveRenderFrame(state.models, state.geometryResult)).pairs;
  if (!pairs.length) throw new Error('No loaded model has list data.');
  const stamp = captureAnalysisStamp();
  const models = captureListRunModels(definition, pairs, state, options.legacyName ?? 'Loaded model');
  const result = await runListFederated(definition, pairs, state, {
    evaluatorModels: evaluatorModelsFromState(state), signal: options.signal,
  });
  options.signal?.throwIfAborted(); options.checkpoint?.();
  const now = useViewerStore.getState();
  if (options.checkpoint && (now.models !== state.models || now.mutationVersion !== state.mutationVersion || now.geometryContentVersion !== state.geometryContentVersion)) throw new Error('The federation changed during the list run. Discarded result.');
  return recordListRun(result, definition, stamp, models);
}
