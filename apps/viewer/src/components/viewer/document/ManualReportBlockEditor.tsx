/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The manual report block's editor body (#6401): which checklist it holds,
 *  which model's answers to take, and a Refresh that re-snapshots both.
 *  Refresh reads the model the block was taken from (by fingerprint, not
 *  name); when that model is not loaded it says so and waits for a pick. */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import type { ManualReportBlock } from '@/lib/document/manual-report-types';
import { replaceManualReportSnapshot } from '@/lib/document/manual-report';
import { field } from './BlockEditor.parts';
import { resolveReportModel } from '@/lib/validation/manual/manual-model';
import { useManualReportSource } from './useManualReportSource';

export function ManualReportBlockEditor({ block, onChange }: { block: ManualReportBlock; onChange: (block: ManualReportBlock) => void }) {
  const { t } = useTranslation();
  const source = useManualReportSource();
  const [picked, setPicked] = useState<string | null>(null);
  const resolved = resolveReportModel(source.models, block.modelFingerprint, picked, source.defaultModelId);
  const missing = resolved.kind === 'missing';
  const chosen = resolved.kind === 'model' ? resolved.model?.id ?? null : null;
  const missingChecklist = block.checklistId !== undefined && !source.checklists.some((entry) => entry.id === block.checklistId);
  const available = block.checklistId !== undefined ? !missingChecklist : source.activeChecklistId !== null;
  const replaceSnapshot = (checklistId?: string) => {
    if (missing) return false;
    const next = source.snapshot(block.id, chosen, checklistId);
    if (!next) return false;
    onChange(replaceManualReportSnapshot(block, next));
    return true;
  };

  return (
    <div className="flex flex-col gap-1">
      <label className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">{t('manualValidation.report.sourceLabel')}
        <select className={`${field} min-w-0 flex-1`} aria-label={t('manualValidation.report.sourceLabel')} value={block.checklistId ?? ''} disabled={missing}
          onChange={(event) => replaceSnapshot(event.target.value)}>
          {(block.checklistId === undefined || missingChecklist) && <option value={block.checklistId ?? ''} disabled>{block.checklistName.trim() || t('manualValidation.name.placeholder')}</option>}
          {source.checklists.map((entry) => <option key={entry.id} value={entry.id}>{entry.name.trim() || t('manualValidation.name.placeholder')}</option>)}
        </select>
      </label>
      {missingChecklist && <p className="text-foreground" data-manual-report-checklist-missing>{t('manualValidation.report.checklistMissing')}</p>}
      {missing && (
        <p className="text-foreground" data-manual-report-model-missing>
          {block.modelName?.trim()
            ? t('manualValidation.report.modelNotLoaded', { model: block.modelName })
            : t('manualValidation.report.modelNotLoadedUnnamed')}
        </p>
      )}
      {(source.models.length > 1 || (missing && source.models.length > 0)) && (
        <label className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">{t('manualValidation.report.modelLabel')}
          <select className={`${field} min-w-0 flex-1`} aria-label={t('manualValidation.report.modelLabel')} value={chosen ?? ''} onChange={(e) => setPicked(e.target.value)}>
            {missing && <option value="" disabled>{t('manualValidation.report.pickModel')}</option>}
            {source.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
      )}
      <Button
        variant="outline"
        size="sm"
        className="h-6 w-fit px-2 text-xs"
        disabled={!available || missing}
        title={missingChecklist ? t('manualValidation.report.checklistMissing') : !available ? t('manualValidation.report.unavailableTitle') : missing ? t('manualValidation.report.pickModel') : undefined}
        onClick={() => {
          if (!replaceSnapshot(block.checklistId)) return;
          toast.success(t('manualValidation.report.refreshed'));
        }}
      >
        {t('manualValidation.report.refresh')}
      </Button>
    </div>
  );
}

export function ManualReportPresentation({ block, onChange }: { block: ManualReportBlock; onChange: (block: ManualReportBlock) => void }) {
  const { t } = useTranslation();
  return <>
      <label className="inline-flex items-center gap-1 text-muted-foreground">{t('manualValidation.report.layout')}
        <select className={field} aria-label={t('manualValidation.report.layout')} value={block.variant ?? 'long'} onChange={(event) => onChange({ ...block, variant: event.target.value === 'compact' ? 'compact' : 'long' })}>
          <option value="long">{t('manualValidation.report.long')}</option>
          <option value="compact">{t('manualValidation.report.compact')}</option>
        </select>
      </label>
      <label className="inline-flex items-center gap-1 text-muted-foreground">
        <input type="checkbox" checked={block.benchmarks !== false} onChange={(event) => onChange({ ...block, benchmarks: event.target.checked })} />
        {t('manualValidation.report.benchmarks')}
      </label>
      <label className="inline-flex items-center gap-1 text-muted-foreground">
        <input type="checkbox" checked={block.showStamp !== false} onChange={(event) => onChange({ ...block, showStamp: event.target.checked })} />
        {t('manualValidation.report.showStamp')}
      </label>
  </>;
}
