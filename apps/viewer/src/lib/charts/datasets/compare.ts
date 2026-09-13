/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `compare` chart dataset (#3944): one row per diff entry of the last
 * model comparison. An entry's element is the head-side entity when there
 * is one (added / modified / unchanged) and the base-side one for a deletion
 * — the copy the compare overlay colours in 3D.
 */
import type { ChartDataset, ChartDatasetColumn, ChartDatasetRow } from '@ifc-lite/charts';
import type { ViewerState } from '@/store';

export const COMPARE_COLUMNS = {
  state: 'State',
  change: 'Change',
  ifcType: 'IfcType',
  side: 'Side',
} as const;

export const COMPARE_DATASET_COLUMNS: ChartDatasetColumn[] = [
  { id: COMPARE_COLUMNS.state, label: 'State (added / modified / deleted / unchanged)', kind: 'category' },
  { id: COMPARE_COLUMNS.change, label: 'What changed', kind: 'category' },
  { id: COMPARE_COLUMNS.ifcType, label: 'IFC type', kind: 'category' },
  { id: COMPARE_COLUMNS.side, label: 'Revision', kind: 'category' },
];

export type CompareDatasetState = Pick<ViewerState, 'compareResult' | 'compareRunSeq'>;

export function buildCompareDataset(state: CompareDatasetState): ChartDataset {
  const result = state.compareResult;
  const rows: ChartDatasetRow[] = [];
  if (result) {
    for (const entry of result.diff.entries) {
      const fingerprint = entry.head ?? entry.base;
      if (!fingerprint) continue;
      rows.push({
        ids: [fingerprint.ref.globalId],
        values: [
          entry.state,
          entry.state === 'modified' ? (entry.changeKinds.length > 0 ? entry.changeKinds.join(' + ') : 'modified') : entry.state,
          fingerprint.ifcType,
          entry.head ? result.headName : result.baseName,
        ],
      });
    }
  }
  return { source: 'compare', columns: COMPARE_DATASET_COLUMNS, rows, fingerprint: `compare:${state.compareRunSeq}:${rows.length}` };
}
