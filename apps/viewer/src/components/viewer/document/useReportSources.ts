/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every place a validation report block can take its evidence from (#6553):
 * the saved reports of the Data validation tab (IDS, information validation
 * and manual, one list) and the two live sources (the current IDS or
 * information validation run, the current manual checklist). The Add block
 * menu and the block's source picker both read this one hook, so adding a
 * block and switching its source build the same block.
 */

import { useCallback } from 'react';
import type { ValidationReport } from '@ifc-lite/ids';
import { useViewerStore } from '@/store';
import { idsReportBlockFromReport } from '@/lib/document/ids-report';
import { emptyManualReportBlock } from '@/lib/document/manual-report';
import { savedReportBlock, type SavedValidationReport, type ValidationReportSnapshot } from '@/lib/validation/reports/history';
import { useManualReportSource } from './useManualReportSource';

/** The picker's value for a live source; a saved report's value is its id. */
export const LIVE_IDS_SOURCE = 'live:ids';
export const LIVE_MANUAL_SOURCE = 'live:manual';

export interface ReportSources {
  saved: SavedValidationReport[];
  /** The current IDS or information validation run, if any. */
  liveIds: ValidationReport | null;
  /** A manual checklist exists to snapshot. */
  liveManualAvailable: boolean;
  /** Something can seed a report block. */
  available: boolean;
  /** A saved report as a block, the way History "add to document" has always built it. */
  fromSaved: (entry: SavedValidationReport, id: string) => ValidationReportSnapshot;
  /** The current run as a compact block with benchmarks on, as the old IDS menu item built it. */
  fromLiveIds: (id: string) => ValidationReportSnapshot | null;
  /** The current checklist, or null when none exists. */
  fromLiveManual: (id: string) => ValidationReportSnapshot | null;
  /** What the Add block entry inserts: the latest saved report, else the current run, else the current checklist. */
  seed: (id: string) => ValidationReportSnapshot | null;
}

export function useReportSources(): ReportSources {
  const saved = useViewerStore((s) => s.savedValidationReports);
  const liveIds = useViewerStore((s) => s.idsValidationReport);
  const manual = useManualReportSource();

  const fromSaved = useCallback((entry: SavedValidationReport, id: string): ValidationReportSnapshot => {
    const block = savedReportBlock(entry, id);
    return block.kind === 'ids-report' ? { ...block, benchmarks: block.benchmarks ?? true } : block;
  }, []);
  const fromLiveIds = useCallback((id: string) => (liveIds ? { ...idsReportBlockFromReport(liveIds, id, 'compact'), benchmarks: true } : null), [liveIds]);
  const fromLiveManual = useCallback((id: string) => (manual.available
    ? manual.snapshot(id, null, manual.defaultChecklistId ?? undefined) ?? emptyManualReportBlock(id)
    : null), [manual]);
  const seed = useCallback((id: string) => {
    const latest = saved.at(-1);
    return latest ? fromSaved(latest, id) : fromLiveIds(id) ?? fromLiveManual(id);
  }, [saved, fromSaved, fromLiveIds, fromLiveManual]);

  return { saved, liveIds, liveManualAvailable: manual.available, available: saved.length > 0 || liveIds !== null || manual.available, fromSaved, fromLiveIds, fromLiveManual, seed };
}
