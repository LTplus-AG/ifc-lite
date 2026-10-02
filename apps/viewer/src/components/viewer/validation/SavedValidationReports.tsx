/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { SavedHistoryNotice } from '../SavedHistoryNotice';
import { IdsReportPreview } from '../document/IdsReportPreview';
import { ManualReportPreview } from '../document/ManualReportPreview';
import { reportScopeText } from '@/lib/document/report-provenance';
import { savedReportLabel } from '@/lib/validation/reports/history';
import { manualReportReuse } from '@/lib/validation/manual/manual-model';
import { setValidationSourceChoice } from '@/lib/validation/validation-source-choice';

/** Historical evidence is reviewable with no loaded model. In particular,
 * these snapshots never install old entity ids in the live 3D scene (#6500). */
export function SavedValidationReports() {
  const { t } = useTranslation();
  const reports = useViewerStore((s) => s.savedValidationReports);
  const loadIssue = useViewerStore((s) => s.validationReportsLoadIssue);
  const failed = useViewerStore((s) => s.validationReportsSaveFailed);
  const fingerprints = useViewerStore(useShallow((s) => [...s.models.values()].map(model => model.sourceFingerprint || null)));
  const loadStates = useViewerStore(useShallow((s) => [...s.models.values()].map(model => model.loadState)));
  const reuseReport = useViewerStore((s) => s.reuseManualValidationReport);
  const remove = useViewerStore((s) => s.removeValidationReport);
  const rename = useViewerStore((s) => s.renameValidationReport);
  const [picked, setPicked] = useState<string | null>(null);
  const report = reports.find((entry) => entry.id === picked) ?? reports.at(-1);

  const snapshot = report?.snapshot;
  const reuse = useMemo(() => snapshot?.kind === 'manual-report'
    ? manualReportReuse(snapshot, fingerprints.map((fingerprint, index) => ({ fingerprint, loadState: loadStates[index] }))) : null, [snapshot, fingerprints, loadStates]);

  return (
    <>
      <SavedHistoryNotice issue={loadIssue} subject={t('validationPanel.history.title')} onRetry={() => useViewerStore.getState().retryValidationReportsSave()} />
      {failed && <p role="alert" className="shrink-0 px-2 py-1 text-xs text-destructive">{t('validationPanel.history.unsaved')}</p>}
      <details className="shrink-0 border-b p-2 text-xs" data-saved-validation-reports>
        <summary className="cursor-pointer font-medium">{t('validationPanel.history.title')} ({reports.length})</summary>
        {report ? (
          <div className="mt-2 flex max-h-72 flex-col gap-2 overflow-auto">
            <select aria-label={t('validationPanel.history.select')} value={report.id} className="rounded border border-input bg-background p-1" onChange={(e) => setPicked(e.target.value)}>
              {reports.map((entry) => <option key={entry.id} value={entry.id}>{savedReportLabel(entry)}</option>)}
            </select>
            <div className="flex gap-2">
              <input className="min-w-0 flex-1 rounded border border-input bg-background px-2" aria-label={t('validationPanel.history.name')} key={report.id + report.name} defaultValue={report.name} onBlur={(e) => rename(report.id, e.target.value)} />
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => remove(report.id)}>{t('validationPanel.history.remove')}</Button>
            </div>
            {reuse && <>
              <Button variant="outline" size="sm" className="h-7 w-fit text-xs" disabled={!reuse.ok} onClick={() => {
                if (reuseReport(report)) setValidationSourceChoice('manual');
              }}>{t('manualValidation.reuse.editCopy')}</Button>
              {!reuse.ok && <p className="text-muted-foreground">{t(`manualValidation.reuse.${reuse.reason}`)}</p>}
            </>}
            <p className="text-muted-foreground">{t('validationPanel.history.frozen')}</p>
            {reportScopeText(report.snapshot) && <p>{t('validationPanel.history.models', { models: reportScopeText(report.snapshot) })}</p>}
            <div className="rounded bg-white p-2 text-neutral-900">
              {report.snapshot.kind === 'manual-report' ? <ManualReportPreview block={report.snapshot} /> : <IdsReportPreview block={report.snapshot} />}
            </div>
          </div>
        ) : <p className="mt-2 text-muted-foreground">{t('validationPanel.history.empty')}</p>}
      </details>
    </>
  );
}
