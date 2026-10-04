/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Save } from 'lucide-react';
import type { ValidationReport } from '@ifc-lite/ids';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { ContentStorageNotice } from '../ContentStorageNotice';
import { newSavedReport } from '@/lib/validation/reports/history';

/** One explicit save path for IDS and Information validation results (#6568). */
export function SaveValidationReportButton({ report, disabled = false }: { report: ValidationReport; disabled?: boolean }) {
  const { t } = useTranslation();
  const evidence = useViewerStore((s) => s.currentValidationReport);
  const history = useViewerStore((s) => s.savedValidationReports);
  const loading = useViewerStore((s) => s.idsLoading);
  const storage = useViewerStore((s) => s.validationReportsStorage);
  if (evidence?.report !== report) return null;
  const saved = history.some((entry) => entry.id === evidence.savedReportId);
  const retry = () => useViewerStore.getState().retryValidationReportsSave();
  const save = async () => {
    const state = useViewerStore.getState();
    const current = state.currentValidationReport;
    // Read the live state again: a queued click must not duplicate a save or
    // save a report replaced since this control rendered.
    if (disabled || state.idsLoading || current?.report !== report || state.idsValidationReport !== report
      || state.savedValidationReports.some((entry) => entry.id === current.savedReportId)) return;
    const entry = newSavedReport(current.snapshot);
    const pending = state.saveValidationReportEntry(entry);
    state.markValidationReportSaved(report, entry.id);
    const id = await pending;
    if (id) useViewerStore.getState().markValidationReportSaved(report, id);
    else toast.error(t('validationPanel.history.saveRejected'));
  };
  return <>
    <Button type="button" variant="outline" size="sm" className="h-8 text-xs" disabled={disabled || loading || saved} onClick={save}>
      <Save className="h-3.5 w-3.5" />
      {t(saved ? storage.items[evidence.savedReportId ?? ''] === 'saved' ? 'validationPanel.history.saved' : 'validationPanel.history.savePending' : 'validationPanel.history.saveReport')}
    </Button>
    <div className="basis-full"><ContentStorageNotice status={storage} restore={() => useViewerStore.getState().restoreValidationReports()} retry={retry} /></div>
  </>;
}
