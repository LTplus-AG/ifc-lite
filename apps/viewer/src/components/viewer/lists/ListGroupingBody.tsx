/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ColumnDefinition } from '@ifc-lite/lists';
import { useTranslation } from '@/i18n';
import { Chip } from './ListBuilder.parts';

export function GroupingBody({
  columns,
  groupByColumnIds,
  sumColumnIds,
  onGroupLevelChange,
  onToggleSum,
}: {
  columns: ColumnDefinition[];
  /** Ordered group-by columns, outermost first (multi-criteria grouping #1790). */
  groupByColumnIds: string[];
  sumColumnIds: Set<string>;
  onGroupLevelChange: (level: number, id: string) => void;
  onToggleSum: (id: string) => void;
}) {
  const { t } = useTranslation();
  // One select per active level, plus a trailing empty slot to add the next
  // level (as long as ungrouped columns remain).
  const levelSlots = groupByColumnIds.length < columns.length
    ? [...groupByColumnIds, '']
    : groupByColumnIds;
  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-card p-2.5">
      <div className="space-y-1.5">
        {levelSlots.map((id, level) => (
          <label key={level} className="flex items-center gap-2 text-xs">
            <span className="w-16 shrink-0 text-muted-foreground">{level === 0 ? t('lists.builder.groupByLabel') : t('lists.builder.thenByLabel')}</span>
            <select
              value={id}
              onChange={(e) => onGroupLevelChange(level, e.target.value)}
              className="h-7 flex-1 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">{level === 0 ? t('lists.builder.noneFlatList') : t('lists.builder.none')}</option>
              {columns
                .filter((c) => c.id === id || !groupByColumnIds.includes(c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>{c.label ?? c.propertyName}</option>
                ))}
            </select>
          </label>
        ))}
        {groupByColumnIds.length > 0 && (
          <div className="text-2xs text-muted-foreground">
            {t('lists.builder.groupCountHint')}
          </div>
        )}
      </div>
      <div>
        <div className="mb-1 text-2xs text-muted-foreground">
          {t('lists.builder.totalsHint')}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {columns.map((c) => (
            <Chip key={c.id} selected={sumColumnIds.has(c.id)} onClick={() => onToggleSum(c.id)}>
              <span className="font-mono">{t('lists.builder.sumIcon')}</span> {c.label ?? c.propertyName}
            </Chip>
          ))}
        </div>
      </div>
    </div>
  );
}
