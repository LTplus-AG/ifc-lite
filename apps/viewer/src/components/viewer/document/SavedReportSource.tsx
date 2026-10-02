/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';
import { SavedHistoryNotice } from '../SavedHistoryNotice';
import { useViewerStore } from '@/store';
import { savedReportLabel, type ValidationReportSnapshot } from '@/lib/validation/reports/history';
import { blockTitleFields } from '@/lib/document/block-title';
import { replaceManualReportSnapshot } from '@/lib/document/manual-report';
import { LIVE_IDS_SOURCE, LIVE_MANUAL_SOURCE, useReportSources } from './useReportSources';

/** The author's choices (heading, scale, and the layout the destination kind shares) survive a change of evidence.
 * One list for every switch, saved or live; the shared helpers for these choices can replace it once they are on main. */
function carryPresentation(block: ValidationReportSnapshot, next: ValidationReportSnapshot): ValidationReportSnapshot {
  return block.kind === 'manual-report' && next.kind === 'manual-report'
    ? replaceManualReportSnapshot(block, next)
    : block.kind === 'ids-report' && next.kind === 'ids-report'
      ? { ...next, ...blockTitleFields(block), variant: block.variant, benchmarks: block.benchmarks, specificationsOnly: block.specificationsOnly, scale: block.scale }
      : { ...next, ...blockTitleFields(block), scale: block.scale };
}

/** One picker for every source of a report block (#6553): any saved report, whatever its kind, or the
 * current IDS / information validation run or manual checklist. Saved evidence is frozen and keeps its
 * embedded snapshot (#6500); a live choice reads the current run and shows the refresh controls. */
export function SavedReportSource({ block, onChange }: { block: ValidationReportSnapshot; onChange: (block: ValidationReportSnapshot) => void }) {
  const { t } = useTranslation();
  const sources = useReportSources();
  const choices = sources.saved;
  const loadIssue = useViewerStore((s) => s.validationReportsLoadIssue);
  return (
    <>
      <SavedHistoryNotice issue={loadIssue} subject={t('validationPanel.history.title')} onRetry={() => useViewerStore.getState().retryValidationReportsSave()} />
      <label className="flex flex-col gap-1 text-muted-foreground">
        {t('validationPanel.history.documentSource')}
        <select className="min-w-0 rounded border border-input bg-background px-1.5 py-1 text-foreground" aria-label={t('validationPanel.history.documentSource')} value={choices.some((entry) => entry.id === block.savedReportId) ? block.savedReportId : ''}
          onChange={(e) => {
            const picked = e.target.value;
            const entry = choices.find((candidate) => candidate.id === picked);
            const next = picked === LIVE_IDS_SOURCE ? sources.fromLiveIds(block.id)
              : picked === LIVE_MANUAL_SOURCE ? sources.fromLiveManual(block.id)
                : entry ? sources.fromSaved(entry, block.id) : null;
            if (next) onChange(carryPresentation(block, next));
          }}>
          <option value="" disabled>{t('validationPanel.history.embedded')}</option>
          {choices.map((entry) => <option key={entry.id} value={entry.id}>{savedReportLabel(entry)}</option>)}
          {sources.liveIds && <option value={LIVE_IDS_SOURCE}>{t(sources.liveIds.source.kind === 'rules' ? 'document.block.reportSourceLiveRules' : 'document.block.reportSourceLiveIds')}</option>}
          {sources.liveManualAvailable && <option value={LIVE_MANUAL_SOURCE}>{t('document.block.reportSourceLiveManual')}</option>}
        </select>
      </label>
    </>
  );
}
