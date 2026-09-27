/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Apply one Bulk action in yielding chunks while preserving one workspace undo step. */
import type { BulkAction, BulkQueryEngine, BulkQueryResult } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { recordRun } from '@/lib/model-placement/history';
import { newMutationBatchId } from '@/store/slices/mutation-batch-tags';
import type { BulkRuntimeFailure } from './BulkExecutionResult';

interface BulkTarget { modelId: string; id: number }

export async function runBulkTargetBatches(options: {
  targets: readonly BulkTarget[];
  action: BulkAction;
  getEngine: (modelId: string) => BulkQueryEngine | undefined | null;
  isCancelled: () => boolean;
  onProgress: (done: number, total: number) => void;
  modelUnavailable: (modelId: string) => string;
  entityError: (id: number, detail?: string) => string;
}): Promise<{ result: BulkQueryResult; failures: BulkRuntimeFailure[] }> {
  const { targets, action, getEngine, isCancelled, onProgress, modelUnavailable, entityError } = options;
  const total = targets.length;
  const mutations: BulkQueryResult['mutations'] = [];
  const errors: string[] = [];
  const failures: BulkRuntimeFailure[] = [];
  let processed = 0;
  const batchId = newMutationBatchId();
  const recorders = new Map<string, ReturnType<typeof recordRun>>();
  const activeModelIdAtStart = useViewerStore.getState().activeModelId;
  for (let i = 0; i < total; i += 500) {
    if (isCancelled()) break;
    const end = Math.min(i + 500, total);
    const chunk: typeof mutations = [];
    const byModel = new Map<string, typeof mutations>();
    for (let j = i; j < end; j++) {
      const { modelId, id } = targets[j];
      try {
        const engine = getEngine(modelId);
        if (!engine) throw new Error(modelUnavailable(modelId));
        const mutation = engine.applyAction(id, action);
        if (mutation) {
          chunk.push(mutation);
          const group = byModel.get(modelId) ?? [];
          group.push(mutation);
          byModel.set(modelId, group);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : undefined;
        errors.push(entityError(id, detail));
        failures.push({ kind: 'entity', id, detail });
      }
    }
    mutations.push(...chunk);
    for (const [modelId, group] of byModel) {
      let record = recorders.get(modelId);
      if (!record) {
        record = recordRun(useViewerStore.getState, modelId, batchId);
        recorders.set(modelId, record);
      }
      record(group);
    }
    processed = end;
    onProgress(end, total);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const state = useViewerStore.getState();
  const firstRecordedModelId = recorders.keys().next().value;
  if (firstRecordedModelId && state.activeModelId === activeModelIdAtStart
    && (!state.activeModelId || !recorders.has(state.activeModelId))
    && state.models.has(firstRecordedModelId)) state.setActiveModel(firstRecordedModelId);
  const cancelled = isCancelled() && processed < total; // a cancel in the last yield stopped nothing (#5958)
  if (cancelled) failures.push({ kind: 'cancelled', done: processed, total });
  return {
    result: {
      mutations,
      affectedEntityCount: mutations.length,
      success: errors.length === 0 && !cancelled,
      errors: errors.length > 0 ? errors : undefined,
    },
    failures,
  };
}
