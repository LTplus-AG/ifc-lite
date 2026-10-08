/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One IFCX layer's contribution diff as evidence (#6833): the `StackDiff`
 * the Layers panel computed (`layerStackDiff`, prefix-below vs
 * prefix-including that layer), one row per added, modified or deleted path,
 * plus the stack's provenance summary. Paths resolve to viewer entities only
 * through the composition's own `layerStackPathToId` bridge.
 *
 * The diff compares layer FILES, so it is a stored result of the stack, not
 * of the session's edits: replacing the stack clears it (`setLayerStack`),
 * and any edit still makes the snapshot stale through the context stamp.
 */

import type { ViewerState } from '@/store';
import type { LayerStackEntry } from '@/store/slices/layerStackSlice';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { evidenceRow, unavailableCapture, type EvidenceAdapter } from './types';

type ChangeKind = 'added' | 'modified' | 'deleted';

/** Provenance a reader needs; never the parsed document or its bytes. */
function layerSummary(entry: LayerStackEntry, position: number) {
  return {
    id: entry.id, name: entry.name, position, contentId: entry.contentId ?? null,
    nodeCount: entry.nodeCount, byteLength: entry.byteLength,
    authorKind: entry.authorKind ?? null,
    // The principal display identifier only; manifests carry no credentials into the slice.
    authorPrincipal: entry.authorPrincipal ?? null,
    intent: entry.intent ?? null, created: entry.created ?? null, isMerge: entry.isMerge ?? false,
    checks: entry.checksTotal !== undefined ? { passed: entry.checksPassed ?? null, total: entry.checksTotal } : null,
  };
}

function* diffEntries(s: ViewerState): Generator<{ change: ChangeKind; path: string; components: string[] | null }> {
  const diff = s.layerStackDiff?.diff;
  if (!diff) return;
  for (const path of diff.added) yield { change: 'added', path, components: null };
  for (const entry of diff.modified) yield { change: 'modified', path: entry.path, components: entry.components };
  // Deleted paths have no entity in the composition, so they never resolve to one.
  for (const path of diff.deleted) yield { change: 'deleted', path, components: null };
}

export const layerDiffAdapter: EvidenceAdapter = {
  id: 'layerDiff', group: 'coordination', panelIds: ['layers'],
  titleKey: 'assistantSources.layerDiff.title', descriptionKey: 'assistantSources.layerDiff.description',
  rowMeaningKey: 'assistantSources.layerDiff.rows', unavailableKey: 'assistantSources.layerDiff.unavailable',
  suggestionKeys: ['assistantSources.layerDiff.suggestSummary', 'assistantSources.layerDiff.suggestReview'],
  readiness: s => {
    if (s.layerStack.length === 0) return { status: { labelKey: 'assistantSources.layerDiff.noStack' }, ready: false };
    if (s.layerDiffBusy) return { status: { labelKey: 'assistantSources.layerDiff.running' }, ready: false, running: true };
    const diff = s.layerStackDiff?.diff;
    if (!diff) return { status: { labelKey: 'assistantSources.layerDiff.notRun' }, ready: false };
    return { status: { labelKey: 'assistantSources.layerDiff.ready',
      params: { count: diff.added.length + diff.modified.length + diff.deleted.length } }, ready: true };
  },
  identity: s => [s.layerStackDiff, s.layerStack, s.layerStackPathToId],
  capture: (s, limit) => {
    const result = s.layerStackDiff;
    if (!result) return unavailableCapture();
    const { diff } = result;
    const position = s.layerStack.findIndex(entry => entry.id === result.layerId);
    const rows = [];
    for (const entry of diffEntries(s)) {
      if (rows.length >= limit) break;
      const id = entry.change === 'deleted' ? undefined : s.layerStackPathToId?.get(entry.path);
      const ref = id !== undefined ? resolveEntityRef(id) : null;
      rows.push(evidenceRow({ kind: 'layer-diff-entry', modelId: ref?.modelId ?? null, expressId: ref?.expressId ?? null, status: entry.change },
        { path: entry.path, change: entry.change, layerId: result.layerId, components: entry.components,
          resolvedInComposition: ref !== null }));
    }
    return {
      summary: {
        kind: 'layer-contribution-diff', layerId: result.layerId,
        layer: position >= 0 ? layerSummary(s.layerStack[position], position + 1) : null,
        counts: { added: diff.added.length, modified: diff.modified.length, deleted: diff.deleted.length },
        layerCount: s.layerStack.length,
        // Composition order, weakest first; position 1 is the base layer.
        layers: s.layerStack.map((entry, index) => layerSummary(entry, index + 1)),
        units: 'counts of IFCX paths; components are IFCX component keys',
        limitations: "The diff isolates this one layer's contribution (the stack below it vs the stack including it); it is not a comparison against a different model version. Rows are IFCX paths; a path resolves to a viewer entity only when the current composition maps it. Check counts are what the layer manifest records, not a re-run.",
      },
      rows, totalRows: diff.added.length + diff.modified.length + diff.deleted.length, availability: 'available',
    };
  },
};
