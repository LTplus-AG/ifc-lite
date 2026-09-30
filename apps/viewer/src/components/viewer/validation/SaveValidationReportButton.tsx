/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Save } from 'lucide-react';
import type { ValidationReport } from '@ifc-lite/ids';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { SavedHistoryNotice } from '../SavedHistoryNotice';

/** One explicit save path for IDS and Information validation results (#6568). */
export function SaveValidationReportButton({ report, disabled = false }: { report: ValidationReport; disabled?: boolean }) {
  const { t } = useTranslation();
  const evidence = useViewerStore((s) => s.currentValidationReport);
  const history = useViewerStore((s) => s.savedValidationReports);
  const loading = useViewerStore((s) => s.idsLoading);
  const failed = useViewerStore((s) => s.validationReportsSaveFailed);
  const issue = useViewerStore((s) => s.validationReportsLoadIssue);
  if (evidence?.report !== report) return null;
  const saved = history.some((entry) => entry.id === evidence.savedReportId);
  const retry = () => useViewerStore.getState().retryValidationReportsSave();
  const save = () => {
    const state = useViewerStore.getState();
    const current = state.currentValidationReport;
    // Read the live state again: a queued click must not duplicate a save or
    // save a report replaced since this control rendered.
    if (disabled || state.idsLoading || current?.report !== report || state.idsValidationReport !== report
      || state.savedValidationReports.some((entry) => entry.id === current.savedReportId)) return;
    const id = state.saveValidationReport(current.snapshot);
    if (id) state.markValidationReportSaved(report, id);
    else toast.error(t('validationPanel.history.saveRejected'));
  };
  return <>
    <Button type="button" variant="outline" size="sm" className="h-8 text-xs" disabled={disabled || loading || saved} onClick={save}>
      <Save className="h-3.5 w-3.5" />
      {t(saved ? failed ? 'validationPanel.history.savePending' : 'validationPanel.history.saved' : 'validationPanel.history.saveReport')}
    </Button>
    {issue && <div className="basis-full"><SavedHistoryNotice issue={issue} subject={t('validationPanel.history.title')} onRetry={retry} /></div>}
    {failed && !issue && <div role="alert" className="basis-full text-xs text-destructive">
      <p>{t('validationPanel.history.unsaved')}</p>
      <Button type="button" variant="outline" size="sm" className="mt-1 h-7 text-xs" onClick={retry}>{t('validationPanel.history.retrySave')}</Button>
    </div>}
  </>;
}
