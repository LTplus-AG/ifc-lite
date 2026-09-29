/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The manual report block's editor body (#6401): which checklist it holds,
 *  which model's answers to take, and a Refresh that re-snapshots both. */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import type { ManualReportBlock } from '@/lib/document/manual-report-types';
import { field } from './BlockEditor.parts';
import { useManualReportSource } from './useManualReportSource';

export function ManualReportBlockEditor({ block, onChange }: { block: ManualReportBlock; onChange: (block: ManualReportBlock) => void }) {
  const { t } = useTranslation();
  const source = useManualReportSource();
  const [modelId, setModelId] = useState<string | null>(
    () => source.models.find((m) => m.name === block.modelName)?.id ?? null,
  );
  const chosen = modelId ?? source.defaultModelId;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1 text-muted-foreground">{t('manualValidation.report.sourceLabel')}
        <span className="min-w-0 truncate font-medium text-foreground" title={block.checklistName}>
          {block.checklistName.trim() || t('manualValidation.name.placeholder')}
        </span>
      </div>
      {source.models.length > 1 && (
        <label className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">{t('manualValidation.report.modelLabel')}
          <select className={`${field} min-w-0 flex-1`} value={chosen ?? ''} onChange={(e) => setModelId(e.target.value)}>
            {source.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
      )}
      <Button
        variant="outline"
        size="sm"
        className="h-6 w-fit px-2 text-xs"
        disabled={!source.available}
        title={source.available ? undefined : t('manualValidation.report.unavailableTitle')}
        onClick={() => {
          const next = source.snapshot(block.id, chosen);
          if (!next) return;
          onChange(next);
          toast.success(t('manualValidation.report.refreshed'));
        }}
      >
        {t('manualValidation.report.refresh')}
      </Button>
    </div>
  );
}
