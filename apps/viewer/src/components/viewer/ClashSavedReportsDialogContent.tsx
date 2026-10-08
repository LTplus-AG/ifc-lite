/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The saved clash reports dialog (#6947): save the current result under a
 * name, rename or delete saved ones. Loaded on first open by
 * `ClashSavedReportsDialog`, so neither the dialog nor the capture and
 * validation code behind it is part of the boot bundle. The reports live in
 * the saved content library (`savedClashReportsSlice`), so they follow reload,
 * backup and import like saved comparisons; charts choose one in the chart editor.
 */

import { useEffect, useState } from 'react';
import { Archive, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { ContentStorageNotice } from '@/components/viewer/ContentStorageNotice';
import { analysisStampOf, useAnalysisStaleness } from '@/hooks/useAnalysisStaleness';
import { useTranslation } from '@/i18n';
import { CLASH_REPORT_LIMITS, clashReportRevision, defaultClashReportName, snapshotClashReport, type SavedClashReport } from '@/lib/clash/saved-report';
import { clashReportLimitBadges } from '@/lib/charts/chart-source-message';
import { useViewerStore } from '@/store';

function ReportRow({ report }: { report: SavedClashReport }) {
  const { t } = useTranslation();
  const models = useViewerStore((s) => s.models);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const [name, setName] = useState(report.name);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { setName(report.name); }, [report.name]);
  const persisted = (ok: boolean): void => { if (!ok) toast.error(t('clashTools.savedReports.storageFailed')); };
  const badges = clashReportLimitBadges(report, clashReportRevision(report, [...models.values()], mutationVersion), t);
  const state = useViewerStore.getState;
  return (
    <li className="space-y-1 rounded-md border border-border p-2" data-clash-report={report.id}>
      <div className="flex gap-1.5">
        <input className="min-w-0 flex-1 rounded border border-border bg-transparent px-1.5 py-0.5 text-xs" value={name}
          maxLength={CLASH_REPORT_LIMITS.name} onChange={(event) => setName(event.target.value)} aria-label={t('clashTools.savedReports.renameLabel', { name: report.name })} />
        <Button variant="outline" size="sm" className="h-6 px-2 text-xs" disabled={!name.trim() || name.trim() === report.name}
          onClick={() => void state().renameSavedClashReport(report.id, name).then(persisted)}>{t('clashTools.savedReports.renameButton')}</Button>
        {!confirming && <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => setConfirming(true)}>{t('clashTools.savedReports.deleteButton')}</Button>}
      </div>
      <div className="text-xs text-muted-foreground">
        {t('clashTools.savedReports.entrySummary', { clashes: t('clashTools.revisionCompare.clashCount', { count: report.clashes.length }), when: new Date(report.savedAt).toLocaleString(), models: report.models.map((model) => model.name).join(', ') })}
      </div>
      {badges.length > 0 && <div className="text-xs font-medium" data-clash-report-limits>{badges.join(' · ')}</div>}
      {confirming && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs" role="alert">
          <span className="min-w-0 flex-1">{t('clashTools.savedReports.deleteWarning', { name: report.name })}</span>
          <Button variant="destructive" size="sm" className="h-6 px-2 text-xs" onClick={() => void state().deleteSavedClashReport(report.id).then(persisted)}>{t('clashTools.savedReports.confirmDeleteButton')}</Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setConfirming(false)}>{t('clashTools.savedReports.cancelDeleteButton')}</Button>
        </div>
      )}
    </li>
  );
}

export function ClashSavedReportsDialogContent({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  // Every open, not only the first: a library that could not be read (or whose rules could not be fetched) is tried again.
  useEffect(() => { if (open) void useViewerStore.getState().initializeSavedClashReports(); }, [open]);
  const result = useViewerStore((s) => s.clashResult);
  const rawResult = useViewerStore((s) => s.clashRawResult);
  const running = useViewerStore((s) => s.clashRunning);
  const reports = useViewerStore((s) => s.savedClashReports);
  const storage = useViewerStore((s) => s.savedClashReportsStorage);
  const stale = useAnalysisStaleness(analysisStampOf(rawResult ?? result));
  const [name, setName] = useState('');
  // What the saved report will be labelled with, in the words its charts will use.
  const excluded = useViewerStore((s) => s.clashSuppressedCount);
  const limits = [...(result?.truncated ? [t('clashChart.badgePartial')] : []), ...(result && stale ? [t('clashChart.badgeStale')] : []),
    ...(result && excluded > 0 ? [t('clashChart.badgeExcluded', { count: excluded })] : [])];

  const saveCurrent = async (): Promise<void> => {
    const state = useViewerStore.getState();
    const report = snapshotClashReport(state, name);
    if (!report) return;
    if (await state.saveClashReport(report)) {
      toast.success(t('clashTools.savedReports.savedToast', { name: report.name }));
      setName('');
    } else toast.error(t('clashTools.savedReports.storageFailed'));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Archive className="h-4 w-4" />
            {t('clashTools.savedReports.triggerTooltip')}
          </DialogTitle>
          <DialogDescription>{t('clashTools.savedReports.dialogDescription')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5 rounded-md border border-border p-2.5">
            <div className="flex gap-1.5">
              <input className="min-w-0 flex-1 rounded border border-border bg-transparent px-1.5 py-0.5 text-xs" value={name}
                maxLength={CLASH_REPORT_LIMITS.name} onChange={(event) => setName(event.target.value)} aria-label={t('clashTools.savedReports.nameLabel')}
                placeholder={result ? defaultClashReportName(result, new Date()) : t('clashTools.savedReports.nameLabel')} />
              <Button variant="outline" size="sm" className="h-7 shrink-0 gap-1" disabled={!result || running} onClick={() => void saveCurrent()}>
                <Save className="h-3.5 w-3.5" />
                {t('clashTools.savedReports.saveButton')}
              </Button>
            </div>
            <div className="text-xs text-muted-foreground" data-clash-report-current>
              {result ? t('clashTools.savedReports.currentSummary', { clashes: t('clashTools.revisionCompare.clashCount', { count: result.clashes.length }) })
                : t('clashTools.revisionCompare.runDetectionFirstTooltip')}
              {limits.length > 0 && ` ${t('clashTools.savedReports.currentLimits', { limits: limits.join(', ') })}`}
            </div>
          </div>
          {/* Whether a report is stored, and why the list may be unread: the same notice every saved content library shows. */}
          <ContentStorageNotice status={storage} retry={() => useViewerStore.getState().retrySaveClashReports()}
            restore={() => useViewerStore.getState().restoreSavedClashReports()} />
          {reports.length === 0
            // Only a library that was read can be called empty; loading or unreadable is the notice's to say.
            ? storage.phase === 'ready' && <div className="text-xs text-muted-foreground">{t('clashTools.savedReports.empty')}</div>
            : <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1" aria-label={t('clashTools.savedReports.triggerTooltip')}>
              {reports.map((report) => <ReportRow key={report.id} report={report} />)}
            </ul>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
