/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { reportChartDependencies, type ChartDependencyPreview, type ReportSource } from '@/lib/reports/chart-dependencies';
import type { SavedComparison } from '@/lib/compare/savedComparisons';
import type { SavedClashReport } from '@/lib/clash/saved-report';

type Report = SavedComparison | SavedClashReport;
export function ReportDeletionPreview({ source, report, onCancel, onDeleted, storageFailed }: {
  source: ReportSource; report: Report; onCancel: () => void; onDeleted?: () => void; storageFailed: () => void;
}) {
  const { t } = useTranslation();
  useViewerStore(s => s.dashboards); useViewerStore(s => s.documents); useViewerStore(s => s.documentsStorage);
  useViewerStore(s => source.kind === 'compare' ? s.savedComparisons : s.savedClashReports);
  const captured = useRef(report);
  const active = useRef({ alive: true });
  const action = useRef(source.kind === 'compare' ? useViewerStore.getState().deleteSavedComparison : useViewerStore.getState().deleteSavedClashReport);
  const [acknowledged, setAcknowledged] = useState<ChartDependencyPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [, refreshRead] = useState(0);
  const state = useViewerStore.getState();
  const preview = reportChartDependencies(state, source);
  const current = source.kind === 'compare' ? state.savedComparisons.find(row => row.id === source.id) : state.savedClashReports.find(row => row.id === source.id);
  const sourceChanged = current !== captured.current;
  const changed = !!acknowledged && acknowledged.signature !== preview.signature;
  useEffect(() => {
    const owner = { alive: true };
    active.current = owner;
    const changedStorage = () => refreshRead(value => value + 1);
    window.addEventListener('storage', changedStorage);
    void useViewerStore.getState().initializeDocuments().then(() => {
      if (active.current === owner && owner.alive) setAcknowledged(reportChartDependencies(useViewerStore.getState(), source));
    });
    return () => { owner.alive = false; window.removeEventListener('storage', changedStorage); };
  }, [source.kind, source.id]);
  const remove = async () => {
    const latest = useViewerStore.getState();
    const target = source.kind === 'compare' ? latest.savedComparisons.find(row => row.id === source.id) : latest.savedClashReports.find(row => row.id === source.id);
    const next = reportChartDependencies(latest, source);
    const removeAction = source.kind === 'compare' ? latest.deleteSavedComparison : latest.deleteSavedClashReport;
    if (busy || removeAction !== action.current || target !== captured.current || !acknowledged || next.signature !== acknowledged.signature || next.documentPhase === 'loading') {
      refreshRead(value => value + 1); return;
    }
    const owner = active.current;
    setBusy(true);
    let staged = false;
    let guardRejected = false;
    const beforeWrite = () => {
      const now = useViewerStore.getState();
      const targetNow = source.kind === 'compare' ? now.savedComparisons.find(row => row.id === source.id) : now.savedClashReports.find(row => row.id === source.id);
      const currentAction = source.kind === 'compare' ? now.deleteSavedComparison : now.deleteSavedClashReport;
      const owned = active.current === owner && owner.alive
        && (staged ? targetNow === undefined : targetNow === captured.current);
      if (!owned || currentAction !== removeAction || reportChartDependencies(now, source).signature !== acknowledged.signature) {
        guardRejected = true; return false;
      }
      staged = true;
      return true;
    };
    const ok = await removeAction(source.id, beforeWrite);
    if (!ok && !guardRejected) storageFailed();
    if (active.current === owner && owner.alive) { setBusy(false); if (ok) onDeleted?.(); }
  };
  return <div className="space-y-2 rounded border p-2 text-xs" data-report-deletion-preview role="alert">
    <p>{t('comparePanel.saved.dependencies.warning', { name: captured.current.name })}</p>
    <p>{t('comparePanel.saved.dependencies.count', { count: preview.total })}</p>
    {preview.entries.length > 0 && <ul className="list-disc pl-4">{preview.entries.map(entry => <li key={entry.key}>
      {t(`comparePanel.saved.dependencies.${entry.family}`)}: {entry.name} — {entry.chart}
    </li>)}</ul>}
    {preview.total > preview.entries.length && <p>{t('comparePanel.saved.dependencies.bounded', { count: preview.entries.length, total: preview.total })}</p>}
    {preview.documentPhase === 'loading' && <p>{t('comparePanel.saved.dependencies.loading')}</p>}
    {(preview.documentPhase === 'unavailable' || preview.documentsRecovered || preview.dashboardsUnavailable || preview.omittedDashboards > 0) && <p>{t('comparePanel.saved.dependencies.unavailable')}</p>}
    {sourceChanged && <p>{t('comparePanel.saved.dependencies.sourceChanged')}</p>}
    {changed && <p>{t('comparePanel.saved.dependencies.changed')}</p>}
    <div className="flex flex-wrap gap-2">
      <Button variant="destructive" size="sm" disabled={busy || sourceChanged || changed || !acknowledged || preview.documentPhase === 'loading'} onClick={() => void remove()}>
        {t('clashTools.savedReports.confirmDeleteButton')}
      </Button>
      {changed && !sourceChanged && <Button size="sm" variant="outline" onClick={() => setAcknowledged(reportChartDependencies(useViewerStore.getState(), source))}>{t('comparePanel.saved.dependencies.review')}</Button>}
      <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>{t('clashTools.savedReports.cancelDeleteButton')}</Button>
    </div>
  </div>;
}
