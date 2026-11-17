/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { toast } from '@/components/ui/toast';
import { localeCount, type UseTranslationResult } from '@/i18n';
import type { ExportDialogShellResult } from './ExportDialogShell';

/** Toast and dialog result for a finished STEP export (single or merged): an
 * export with exporter warnings toasts as info and lists them (#10606). */
export function stepExportResult(summary: string, warnings: readonly string[], t: UseTranslationResult['t'], locale: string): ExportDialogShellResult {
  if (!warnings.length) {
    toast.success(summary);
    return { success: true, message: summary };
  }
  const message = `${summary}. ${t('geometryExport.shell.warningsSummary', localeCount(locale, warnings.length))}`;
  toast.info(message);
  return { success: true, message, warnings, warningLimit: 5 };
}
