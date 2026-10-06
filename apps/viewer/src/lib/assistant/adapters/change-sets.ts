/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Named change sets as evidence (#6833): one row per set with bounded
 * metadata (name, active, edit count, models and edit kinds it touches).
 * Edit values and exported file contents are never included.
 */

import { changeSetSummaries, groupChangeSetByElement } from '@/lib/change-sets/change-set-view';
import { evidenceRow, unavailableCapture, type EvidenceAdapter } from './types';

const NAME_CHARS = 160;

export const changeSetsAdapter: EvidenceAdapter = {
  id: 'changeSets', group: 'coordination', panelIds: ['changeSets'],
  titleKey: 'changeSets.panel.title', descriptionKey: 'assistantSources.changeSets.description',
  rowMeaningKey: 'assistantSources.changeSets.rows', unavailableKey: 'assistantSources.changeSets.unavailable',
  suggestionKeys: ['assistantSources.changeSets.suggestSummary'],
  readiness: s => s.changeSets.size > 0
    ? { status: { labelKey: 'assistantSources.changeSets.ready', params: { count: s.changeSets.size } }, ready: true }
    : { status: { labelKey: 'assistantSources.changeSets.none' }, ready: false },
  // The slice replaces the map on every create, rename, record, undo prune and delete.
  identity: s => [s.changeSets, s.activeChangeSetId],
  capture: (s, limit) => {
    if (s.changeSets.size === 0) return unavailableCapture();
    const summaries = changeSetSummaries(s.changeSets, s.activeChangeSetId);
    const rows = summaries.slice(0, limit).map(summary => {
      const set = s.changeSets.get(summary.id);
      const mutations = set?.mutations ?? [];
      const editKinds: Record<string, number> = {};
      for (const mutation of mutations) editKinds[mutation.type] = (editKinds[mutation.type] ?? 0) + 1;
      const groups = set ? groupChangeSetByElement(set) : [];
      return evidenceRow({ kind: 'changeSet', status: summary.active ? 'active' : 'inactive' }, {
        id: summary.id,
        name: summary.name.length > NAME_CHARS ? `${summary.name.slice(0, NAME_CHARS)}…` : summary.name,
        active: summary.active, editCount: summary.mutationCount,
        elementCount: groups.filter(group => group.entityId > 0).length,
        modelLevelEditGroups: groups.filter(group => group.entityId === 0).length,
        modelIds: [...new Set(mutations.map(mutation => mutation.modelId))],
        editKinds, createdAt: new Date(summary.createdAt).toISOString(),
        applied: set?.applied ?? null,
      });
    });
    return {
      summary: {
        kind: 'change-sets', setCount: summaries.length, activeSetId: s.activeChangeSetId,
        editsInSets: summaries.reduce((sum, summary) => sum + summary.mutationCount, 0),
        emptySets: summaries.filter(summary => summary.mutationCount === 0).length,
        order: 'Oldest set first.',
        limitations: 'Rows are change set metadata only: edit values and exported file contents are not included. '
          + 'The viewer records no last-updated or exported time for a set, so neither is reported. '
          + 'Discarding a set drops its record of edits but not the edits themselves; edits made with no active set belong to no row.',
      },
      rows, totalRows: summaries.length, availability: 'available',
    };
  },
};
