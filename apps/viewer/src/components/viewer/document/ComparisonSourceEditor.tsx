/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { comparisonSummary } from '@/lib/compare/savedComparisonSchema';
import type { ComparisonTableSource, TableBlock } from '@/lib/document/types';
import { field } from './BlockEditor.parts';

export function ComparisonSourceEditor({ block, source, onChange }: { block: TableBlock; source: ComparisonTableSource; onChange: (block: TableBlock) => void }) {
  const { t } = useTranslation();
  const saved = useViewerStore((s) => s.savedComparisons);
  return <>
    <label className="flex items-center gap-2 text-muted-foreground">{t('document.block.tableSourceComparison')}
      <select className={`${field} min-w-0 flex-1`} value="" aria-label={t('document.block.comparisonPicker')} onChange={(e) => {
        const comparison = saved.find((c) => c.id === e.target.value);
        if (comparison) onChange({ ...block, source: { kind: 'comparison', comparison: structuredClone(comparison) } });
      }}>
        <option value="" disabled>{source.comparison.name}</option>
        {saved.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.report.baseModel} → {c.report.headModel}</option>)}
      </select>
    </label>
    <div className="space-y-0.5 text-muted-foreground">{comparisonSummary(source.comparison).map((line, i) => <p key={i}>{line}</p>)}</div>
    <p className="text-muted-foreground">{t('document.block.comparisonSnapshotHint')}</p>
  </>;
}
