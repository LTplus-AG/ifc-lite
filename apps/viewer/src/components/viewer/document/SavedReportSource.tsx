/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';
import { ContentStorageNotice } from '../ContentStorageNotice';
import { useViewerStore } from '@/store';
import { savedReportLabel, type ValidationReportSnapshot } from '@/lib/validation/reports/history';
import { keepCommonReportChoices } from '@/lib/document/report-provenance';
import { replaceManualReportSnapshot } from '@/lib/document/manual-report';
import { replaceIdsReportSnapshot } from '@/lib/document/ids-report';
import { LIVE_IDS_SOURCE, LIVE_MANUAL_SOURCE, useReportSources } from './useReportSources';

/** The author's choices survive a change of evidence, saved or live, same kind or across kinds: the
 * shared rules decide what is kept (heading, size, stamp, and the layout the destination kind shares). */
function carryPresentation(block: ValidationReportSnapshot, next: ValidationReportSnapshot): ValidationReportSnapshot {
  return block.kind === 'manual-report' && next.kind === 'manual-report'
    ? replaceManualReportSnapshot(block, next)
    : block.kind === 'ids-report' && next.kind === 'ids-report'
      ? replaceIdsReportSnapshot(block, next)
      : keepCommonReportChoices(block, next);
}

/** One picker for every source of a report block (#6553): any saved report, whatever its kind, or the
 * current IDS / information validation run or manual checklist. Saved evidence is frozen and keeps its
 * embedded snapshot (#6500); a live choice reads the current run and shows the refresh controls. */
export function SavedReportSource({ block, onChange }: { block: ValidationReportSnapshot; onChange: (block: ValidationReportSnapshot) => void }) {
  const { t } = useTranslation();
  const sources = useReportSources();
  const choices = sources.saved;
  const storage = useViewerStore((s) => s.validationReportsStorage);
  return (
    <>
      <ContentStorageNotice status={storage} restore={() => useViewerStore.getState().restoreValidationReports()} retry={() => useViewerStore.getState().retryValidationReportsSave()} />
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
