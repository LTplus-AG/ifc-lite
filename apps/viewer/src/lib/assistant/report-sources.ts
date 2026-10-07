/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The only per-source part of AI reports (#6918): optional native table blocks
 * for sources that already have a native document table. Every other part of
 * a report reads `EvidenceSnapshot.source` and the captured payload generically.
 * When the evidence adapter registry lands, an adapter can contribute its
 * table here under its source id; sources without an entry get none.
 */

import { useViewerStore } from '@/store';
import { snapshotComparison } from '../compare/savedComparisons';
import { freshBlockId } from '../document/persistence';
import { TABLE_ROWS_DEFAULT, type TableBlock } from '../document/types';

export interface NativeTableContext {
  /** Report title, used to name embedded snapshots. */
  title: string;
}

type NativeTables = (context: NativeTableContext) => TableBlock[];

const NATIVE_TABLES: Record<string, NativeTables> = {
  // Live binding: printed from the validation run loaded when the document is shown, captioned as such.
  validation: () => useViewerStore.getState().idsValidationReport ? [{ kind: 'table', id: freshBlockId(),
    source: { kind: 'validation', rows: 'failed', columns: ['rule', 'entityType', 'name', 'globalId', 'actual', 'expected'] },
    title: 'Native validation results (live)', maxRows: TABLE_ROWS_DEFAULT,
    caption: 'Live native table: shows the validation run loaded when this document is shown or printed, which can differ from the captured evidence of this report.' }] : [],
  // Immutable copy of the same native comparison the evidence was captured from.
  compare: ({ title }) => {
    const state = useViewerStore.getState();
    if (!state.compareResult) return [];
    const comparison = snapshotComparison(state.compareResult, state.models, `${title} - native comparison`);
    return [{ kind: 'table', id: freshBlockId(), source: { kind: 'comparison', comparison }, title: 'Native comparison results',
      maxRows: TABLE_ROWS_DEFAULT, caption: `Native comparison snapshot saved with this report at ${comparison.savedAt}.` }];
  },
};

/** Native tables for a current (never historical) capture of `source`. */
export function nativeTableBlocks(source: string, context: NativeTableContext): TableBlock[] {
  return Object.hasOwn(NATIVE_TABLES, source) ? NATIVE_TABLES[source](context) : [];
}
