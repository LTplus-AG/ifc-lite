/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { savedReportBlock, savedReportLabel, type ValidationReportSnapshot } from '@/lib/validation/reports/history';

/** Select frozen evidence without changing its block id or reading any live
 * checklist/report. Existing documents keep their embedded snapshot (#6500). */
export function SavedReportSource({ block, onChange }: { block: ValidationReportSnapshot; onChange: (block: ValidationReportSnapshot) => void }) {
  const { t } = useTranslation();
  const reports = useViewerStore((s) => s.savedValidationReports);
  const choices = reports;
  return (
    <label className="flex flex-col gap-1 text-muted-foreground">
      {t('validationPanel.history.documentSource')}
      <select className="min-w-0 rounded border border-input bg-background px-1.5 py-1 text-foreground" aria-label={t('validationPanel.history.documentSource')} value={choices.some((entry) => entry.id === block.savedReportId) ? block.savedReportId : ''}
        onChange={(e) => {
          const entry = choices.find((candidate) => candidate.id === e.target.value);
          if (entry) onChange(savedReportBlock(entry, block.id));
        }}>
        <option value="" disabled>{t('validationPanel.history.embedded')}</option>
        {choices.map((entry) => <option key={entry.id} value={entry.id}>{savedReportLabel(entry)}</option>)}
      </select>
    </label>
  );
}
