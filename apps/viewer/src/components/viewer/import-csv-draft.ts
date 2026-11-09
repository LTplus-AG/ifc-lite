/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CsvConnector, DataMapping, ImportProgress, ImportStats } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { recordRun } from '@/lib/model-placement/history';

interface CsvImportDraft {
  connector: CsvConnector | null;
  content: string;
  canEdit: boolean;
  modelId: string;
  isCurrent: () => boolean;
  mapping: () => DataMapping | null;
  processing: (value: boolean) => void;
  stats: (value: ImportStats | null) => void;
  progress: (value: ImportProgress | null) => void;
  error: (value: string | null) => void;
  dirty: (value: boolean) => void;
}

/** Retired completions cannot disable a retry or replace a newer draft's UI. */
export async function importCsvDraft(p: CsvImportDraft): Promise<void> {
  if (!p.connector || !p.content || !p.canEdit || !p.isCurrent()) return;
  p.processing(true); p.stats(null); p.progress(null); p.error(null);
  try {
    const mapping = p.mapping();
    if (!mapping) { p.error('Invalid mapping configuration'); return; }
    const result = await p.connector.importAsync(p.content, mapping, progress => {
      if (p.isCurrent()) p.progress(progress);
    }, {
      // Always record writes already applied, including partial batches before cancellation.
      onApplied: recordRun(useViewerStore.getState, p.modelId),
    });
    if (!p.isCurrent()) return;
    p.stats(result); p.progress(null); p.dirty(result.errors.length > 0);
    if (result.errors.length > 0) p.error(result.errors.join('\n'));
  } catch (error) {
    console.error('Import failed:', error);
    if (p.isCurrent()) p.error(`Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  } finally {
    if (p.isCurrent()) p.processing(false);
  }
}
