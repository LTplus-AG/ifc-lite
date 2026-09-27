/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { downloadFile, modelExportFilename } from '@/lib/export/download.js';
import type { Mutation } from '@ifc-lite/mutations';
import { changeOperations } from '@/lib/changes/change-operations.js';
import type { StoreApi } from 'zustand';
import type { ViewerState } from '@/store';
import { inverseMutationTargets, revertedMutationIds } from '@/store/slices/mutation-inverse-registry';

/** Keep direct view writes, but omit recorded commands that Undo or Revert
 * removed from the active history. getMutations() itself is append-only. */
export function activeChangesJsonMutations(
  modelId: string,
  raw: Mutation[],
  store: StoreApi<ViewerState>,
): Mutation[] {
  const { undoStacks, redoStacks, mutationBatchTags } = store.getState();
  const visible = new Set(changeOperations(undoStacks, mutationBatchTags, inverseMutationTargets(store))
    .flatMap(operation => operation.mutations.filter(mutation => mutation.modelId === modelId).map(mutation => mutation.id)));
  const tracked = new Set<string>();
  for (const stacks of [undoStacks, redoStacks]) {
    for (const stack of stacks.values()) for (const mutation of stack) if (mutation.modelId === modelId) tracked.add(mutation.id);
  }
  // A direct view writer may not participate in the viewer's undo stack.
  // Retain its raw record; only stack-tracked records have a known replay state.
  const reverted = revertedMutationIds(store);
  const effectiveViewRecords = raw.filter(mutation => visible.has(mutation.id)
    || (!tracked.has(mutation.id) && !reverted.has(mutation.id)));
  // Georeference commands are model-level history records, not entries in a
  // MutablePropertyView. The drawer still presents them as exportable edits.
  const included = new Set(effectiveViewRecords.map(mutation => mutation.id));
  const georefRecords = (undoStacks.get(modelId) ?? []).filter(mutation =>
    mutation.type === 'UPDATE_ATTRIBUTE' && mutation.attributeName?.startsWith('georef.')
    && visible.has(mutation.id) && !included.has(mutation.id));
  return [...effectiveViewRecords, ...georefRecords];
}

/** One queued edit, as the mutation view records it. */
export type ExportedMutation = unknown;

/**
 * The "Changes only (JSON delta)" export: the session's queued edits as a JSON delta.
 *
 * Source-independent by construction — it is built from the mutation view
 * alone and never touches the model's `IfcDataStore`. That is what keeps it
 * available for a LandXML model, which has no data store at all (#4937), and
 * it is why the dialog's data-store guard must not cover this branch.
 */
export function exportChangesJson(
  modelId: string, modelName: string, mutations: ExportedMutation[],
): string {
  const data = {
    version: 1,
    modelId,
    modelName,
    mutations,
    exportedAt: new Date().toISOString(),
  };
  downloadFile(JSON.stringify(data, null, 2), modelExportFilename(modelName, 'json', '_changes'), 'application/json');
  return `Exported ${mutations.length} changes as JSON`;
}
