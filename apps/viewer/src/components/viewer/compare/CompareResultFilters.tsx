/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';
import { ALL_COMPARE_RESULTS, type CompareResultFilter } from '@/lib/compare/resultFilter';

/** Post-run controls load with the comparison, outside the eager viewer entry. */
export function CompareResultFilters({ filter, onFilter }: {
  filter: CompareResultFilter;
  onFilter: (filter: CompareResultFilter) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="px-3 py-2 space-y-2 border-b border-border">
      <p className="text-2xs text-muted-foreground">{t('comparePanel.filters.hint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs flex items-center gap-2">
          {t('comparePanel.filters.kind')}
          <select aria-label={t('comparePanel.filters.kind')} value={filter.kind ?? ''}
            className="min-w-0 rounded border border-border bg-background px-2 py-1"
            onChange={(event) => {
              const kind = event.target.value;
              if (kind === 'data' || kind === 'geometry' || kind === 'container') onFilter({ category: 'modified', kind });
              else onFilter({ ...filter, kind: null });
            }}>
            <option value="">{t('comparePanel.filters.allKinds')}</option>
            <option value="data">{t('comparePanel.filters.data')}</option>
            <option value="geometry">{t('comparePanel.changeDetail.geometryLabel')}</option>
            <option value="container">{t('comparePanel.filters.container')}</option>
          </select>
        </label>
        <button type="button" onClick={() => onFilter(ALL_COMPARE_RESULTS)}
          disabled={!filter.category && !filter.kind}
          className="text-xs rounded px-2 py-1 hover:bg-muted disabled:opacity-50">
          {t('comparePanel.filters.reset')}
        </button>
      </div>
    </div>
  );
}
