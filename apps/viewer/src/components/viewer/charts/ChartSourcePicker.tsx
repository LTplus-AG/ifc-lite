/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChartSource } from '@ifc-lite/charts';
import type { SavedComparison } from '@/lib/compare/savedComparisons';
import { useTranslation } from '@/i18n/useTranslation';

export const SOURCE_LABELS: Record<ChartSource, string> = {
  elements: 'Elements', clash: 'Clash results', bcf: 'BCF topics',
  schedule: 'Schedule tasks', ids: 'IDS results', compare: 'Model compare',
};

export function ChartSourcePicker({ source, rowCount, comparisonId, history, allowLegacy, className, onSource, onComparison }: {
  source: ChartSource; rowCount: number; comparisonId?: string; history: readonly SavedComparison[];
  allowLegacy: boolean; className: string; onSource: (source: ChartSource) => void; onComparison: (id: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const pending = source === 'compare' && comparisonId === undefined && !allowLegacy;
  return <>
    <label className="flex flex-col gap-0.5">
      <span className="text-muted-foreground">{pending ? t('chartComparison.pending') : rowCount === 0 ? t('chartEditor.sourceLabelEmpty') : t('chartEditor.sourceLabelWithCount', { count: rowCount.toLocaleString() })}</span>
      <select className={className} value={source} onChange={(event) => onSource(event.target.value as ChartSource)} aria-label={t('chartEditor.sourceAriaLabel')}>
        {(Object.keys(SOURCE_LABELS) as ChartSource[]).map((key) => <option key={key} value={key}>{SOURCE_LABELS[key]}</option>)}
      </select>
    </label>
    {source === 'compare' && <label className="flex flex-col gap-0.5">
      <span className="text-muted-foreground">{t('chartComparison.label')}</span>
      <select className={className} aria-label={t('chartComparison.label')} value={comparisonId ?? ''} onChange={(event) => onComparison(event.target.value || undefined)}>
        <option value="">{t(allowLegacy ? 'chartComparison.legacy' : 'chartComparison.choose')}</option>
        {comparisonId && !history.some((entry) => entry.id === comparisonId) && <option value={comparisonId}>{t('chartComparison.unavailable')}</option>}
        {history.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select>
      {history.length === 0 && <span className="text-muted-foreground">{t('chartComparison.none')}</span>}
    </label>}
  </>;
}
