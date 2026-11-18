/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { toast } from '@/components/ui/toast';
import { formatLocaleNumber, getLocale, localeCount, type UseTranslationResult } from '@/i18n';
import type { ExportDialogShellResult } from './ExportDialogShell';

/** Toast and dialog result for a finished STEP export (single or merged): an
 * export with exporter warnings toasts as info and lists them (#10606).
 * Lines are not deduplicated: each one counts records (e.g. "1 structural
 * conversion record(s): ..."), so an equal line is another fact. The count
 * is formatted for the active locale (`getLocale()`), which `t` also reads. */
export function stepExportResult(summary: string, warnings: readonly string[], t: UseTranslationResult['t']): ExportDialogShellResult {
  if (!warnings.length) {
    toast.success(summary);
    return { success: true, message: summary };
  }
  // A summary that ends with a skip notice already ends in a period.
  const message = `${summary.replace(/\.$/, '')}. ${t('geometryExport.shell.warningsSummary', localeCount(getLocale(), warnings.length))}`;
  toast.info(message);
  return { success: true, message, warnings, warningLimit: 5 };
}

/** Summary line for a merged STEP export. The entity count uses the viewer
 * locale. Cropped sources' warnings come from their export before the crop and
 * carry no entity ids to filter by, so the summary says what they cover. */
export function mergedExportSummary(
  stats: { modelCount: number; totalEntityCount: number; normalizedModelCount: number },
  skipNotice: string,
  hasSectionWarnings: boolean,
  t: UseTranslationResult['t'],
): string {
  const notes = [skipNotice, hasSectionWarnings ? t('exportDialog.sectionWarningsWholeModel') : ''].filter(Boolean).join(' ');
  return `Merged ${stats.modelCount} models, ${formatLocaleNumber(getLocale(), stats.totalEntityCount)} entities`
    + (stats.normalizedModelCount > 0 ? ` (${stats.normalizedModelCount} rescaled into the first model's unit)` : '')
    + (notes ? `. ${notes}` : '');
}
