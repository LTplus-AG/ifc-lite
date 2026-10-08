/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { ContentStorageNotice } from '../ContentStorageNotice';
import { IdsReportPreview } from '../document/IdsReportPreview';
import { ManualReportPreview } from '../document/ManualReportPreview';
import { reportScopeText } from '@/lib/document/report-provenance';
import { useSavedValidationFocus } from '@/lib/panels/evidence-focus';
import { SavedValidationElements } from './SavedValidationElements';
import { savedReportLabel } from '@/lib/validation/reports/history';
import { manualReportReuse } from '@/lib/validation/manual/manual-model';
import { setValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { useLibraryFocus } from '@/lib/libraries/library-focus';

/** Historical evidence is reviewable with no loaded model. In particular,
 * these snapshots never install old entity ids in the live 3D scene (#6500). */
export function SavedValidationReports() {
  const { t } = useTranslation();
  useEffect(() => { void useViewerStore.getState().initializeValidationReports(); }, []);
  const reports = useViewerStore((s) => s.savedValidationReports);
  const storage = useViewerStore((s) => s.validationReportsStorage);
  const fingerprints = useViewerStore(useShallow((s) => [...s.models.values()].map(model => model.sourceFingerprint || null)));
  const loadStates = useViewerStore(useShallow((s) => [...s.models.values()].map(model => model.loadState)));
  const reuseReport = useViewerStore((s) => s.reuseManualValidationReport);
  const remove = useViewerStore((s) => s.removeValidationReport);
  const rename = useViewerStore((s) => s.renameValidationReport);
  const [picked, setPicked] = useState<string | null>(null);
  const requested = useSavedValidationFocus(s => s.record);
  const libraryTarget = useLibraryFocus(s => s.target);
  const libraryRequest = libraryTarget?.kind === 'validation-report' ? libraryTarget : null;
  const libraryReport = libraryRequest ? reports.find(entry => entry.id === libraryRequest.id) : undefined;
  const original = reports.find(entry => entry.id === requested?.reportId && entry.snapshot.generatedAt === requested.capturedAt
    && entry.snapshot.kind === 'ids-report' && entry.snapshot.elementEvidence?.rows.some(row => row.id === requested.rowId));
  const focus = original ? requested : null;
  const report = libraryRequest ? libraryReport : original ?? reports.find((entry) => entry.id === picked) ?? reports.at(-1);
  const disclosure = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => { if (focus && disclosure.current) disclosure.current.open = true; }, [focus]);
  useLayoutEffect(() => { if (libraryRequest && disclosure.current) disclosure.current.open = true; }, [libraryRequest]);

  const snapshot = report?.snapshot;
  const reuse = useMemo(() => snapshot?.kind === 'manual-report'
    ? manualReportReuse(snapshot, fingerprints.map((fingerprint, index) => ({ fingerprint, loadState: loadStates[index] }))) : null, [snapshot, fingerprints, loadStates]);

  return (
    <>
      <ContentStorageNotice status={storage} restore={() => useViewerStore.getState().restoreValidationReports()} retry={() => useViewerStore.getState().retryValidationReportsSave()} />
      <details className="shrink-0 border-b p-2 text-xs" data-saved-validation-reports ref={disclosure}>
        <summary className="cursor-pointer font-medium">{t('validationPanel.history.title')} ({reports.length})</summary>
        {report ? (
          <div className="mt-2 flex flex-col gap-2">
            <select aria-label={t('validationPanel.history.select')} value={report.id} className="rounded border border-input bg-background p-1" onChange={(e) => { useSavedValidationFocus.setState({ record: null }); useLibraryFocus.setState({ target: null }); setPicked(e.target.value); }}>
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
            {report.snapshot.kind === 'ids-report' && <SavedValidationElements snapshot={report.snapshot} rowId={focus?.rowId ?? null} request={focus} />}
          </div>
        ) : <p role={libraryRequest ? 'alert' : undefined} className="mt-2 text-muted-foreground">{t(libraryRequest ? 'searchModal.library.open.missing' : 'validationPanel.history.empty')}</p>}
      </details>
    </>
  );
}
