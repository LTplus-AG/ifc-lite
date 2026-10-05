/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Changes drawer's mutation journal as evidence (#6833). Rows are the
 * individual edits of each active operation, exactly as `changeOperations`
 * groups them for the drawer (federated Bulk batches once, reverted pairs
 * hidden). It is the live undo history, not a model comparison.
 */

import type { Mutation, PropertyValue } from '@ifc-lite/mutations';
import { useViewerStore, type ViewerState } from '@/store';
import { changeOperations } from '@/lib/changes/change-operations';
import { inverseMutationTargets } from '@/store/slices/mutation-inverse-registry';
import { evidenceRow, unavailableCapture, type EvidenceAdapter } from './types';

const VALUE_CHARS = 240;

/** Primitive values pass through; strings and lists are bounded so one edit cannot fill the budget. */
export function boundedValue(value: PropertyValue | undefined): PropertyValue | undefined {
  if (value === undefined || value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > VALUE_CHARS ? `${text.slice(0, VALUE_CHARS)}…` : (typeof value === 'string' ? value : text);
}

function undoDepth(s: ViewerState): number {
  let depth = 0;
  for (const stack of s.undoStacks.values()) depth += stack.length;
  return depth;
}

function stackDepths(stacks: ReadonlyMap<string, readonly Mutation[]>): Record<string, number> {
  return Object.fromEntries([...stacks].map(([modelId, stack]) => [modelId, stack.length]));
}

function baseGlobalId(s: ViewerState, mutation: Mutation): string | null {
  if (mutation.entityId <= 0) return null;
  const store = s.models.get(mutation.modelId)?.ifcDataStore;
  // Created entities live only in the overlay; the base table has no GlobalId for them.
  return store?.entities.getGlobalId(mutation.entityId) || null;
}

function changeRow(s: ViewerState, mutation: Mutation, operationId: string, atUndoTop: boolean) {
  return evidenceRow({
    kind: 'change', modelId: mutation.modelId,
    globalId: baseGlobalId(s, mutation),
    expressId: mutation.entityId > 0 ? mutation.entityId : null,
    unit: mutation.unit ?? null,
  }, {
    operationId, mutationId: mutation.id, type: mutation.type,
    target: mutation.entityId > 0 ? 'entity' : 'model',
    psetName: mutation.psetName ?? null, propName: mutation.propName ?? null,
    attributeName: mutation.attributeName ?? null, entityType: mutation.entityType ?? null,
    sessionKind: mutation.sessionKind ?? null,
    oldValue: boundedValue(mutation.oldValue) ?? null, newValue: boundedValue(mutation.newValue) ?? null,
    wholeSetEdit: mutation.setOverlay !== undefined,
    timestamp: new Date(mutation.timestamp).toISOString(),
    atUndoTop,
  });
}

export const changesAdapter: EvidenceAdapter = {
  id: 'changes', group: 'coordination', panelIds: ['changes'],
  titleKey: 'changesPanel.title', descriptionKey: 'assistantSources.changes.description',
  rowMeaningKey: 'assistantSources.changes.rows', unavailableKey: 'assistantSources.changes.unavailable',
  suggestionKeys: ['assistantSources.changes.suggestSummary', 'assistantSources.changes.suggestReview'],
  readiness: s => {
    if (s.models.size === 0) return { status: { labelKey: 'assistant.pickNoModels' }, ready: false };
    const depth = undoDepth(s);
    return depth > 0 ? { status: { labelKey: 'assistantSources.changes.ready', params: { count: depth } }, ready: true }
      : { status: { labelKey: 'assistantSources.changes.none' }, ready: false };
  },
  // The journal maps are replaced on every record, undo, redo and revert.
  identity: s => [s.undoStacks, s.redoStacks, s.mutationBatchTags],
  capture: (s, limit) => {
    if (s.models.size === 0) return unavailableCapture();
    // Read-only: the drawer prunes the registry on render; capture never writes.
    const operations = changeOperations(s.undoStacks, s.mutationBatchTags, inverseMutationTargets(useViewerStore));
    const byModel: Record<string, { operations: number; edits: number }> = {};
    const byType: Record<string, number> = {};
    const rows: unknown[] = [];
    let totalRows = 0;
    for (const operation of operations) {
      for (const modelId of operation.modelIds) (byModel[modelId] ??= { operations: 0, edits: 0 }).operations++;
      for (const mutation of operation.mutations) {
        totalRows++;
        (byModel[mutation.modelId] ??= { operations: 0, edits: 0 }).edits++;
        byType[mutation.type] = (byType[mutation.type] ?? 0) + 1;
        if (rows.length < limit) rows.push(changeRow(s, mutation, operation.id, operation.isTop));
      }
    }
    return {
      summary: {
        kind: 'mutation-journal', operationCount: operations.length, editCount: totalRows,
        byModel, byType, undoDepthByModel: stackDepths(s.undoStacks), redoDepthByModel: stackDepths(s.redoStacks),
        hiddenRevertedEdits: undoDepth(s) - totalRows,
        order: 'Newest operation first; edits inside an operation in recorded order.',
        limitations: 'This is the active undo history of this session, not a comparison against another model or the file on disk. '
          + 'Reverted edit pairs are hidden as the Changes drawer hides them. Values are as recorded at edit time (long values shortened); '
          + 'whole-set edits carry no per-property values. GlobalId is the source file value and is null for created entities and model-level edits. '
          + 'Edits that were never recorded in the undo history (for example direct imports) do not appear.',
      },
      rows, totalRows, availability: 'available',
    };
  },
};
