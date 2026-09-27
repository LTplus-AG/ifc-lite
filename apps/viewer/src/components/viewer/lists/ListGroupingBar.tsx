/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Status / control strip above the results table. Shows the active grouping
 * and sum columns as removable chips, plus expand/collapse and live totals —
 * the connective tissue between the table and the list definition.
 */

import { Group, Sigma, X, ChevronsDownUp, ChevronsUpDown, ListTree, Table2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n/useTranslation';
import { formatLocaleCount } from './formatLocaleCount';
import { styleInterpolatedValues } from '@/i18n/richInterpolate';

interface ListGroupingBarProps {
  /** Active grouping columns, outermost first (multi-criteria, issue #1790). */
  groups: { id: string; label: string }[];
  sums: { id: string; label: string }[];
  groupCount: number;
  count: number;
  allExpanded: boolean;
  onRemoveGroup: (id: string) => void;
  onRemoveSum: (id: string) => void;
  onToggleExpandAll: () => void;
  /** Result presentation (issue #1790 round 2): `nested` (default, collapsible
   *  tree) or `schedule` (Bonsai-style pivot table — one row per group-value
   *  tuple with Count as its own column). Omitted callers keep the nested-only
   *  toggle hidden (back-compat with call sites built before this existed). */
  view?: 'nested' | 'schedule';
  onViewChange?: (view: 'nested' | 'schedule') => void;
}

function Chip({ icon, children, onRemove, removeLabel }: { icon: React.ReactNode; children: React.ReactNode; onRemove: () => void; removeLabel?: string }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 py-0.5 pl-2 pr-1 text-2xs font-medium text-foreground">
      {icon}
      <span className="max-w-[12rem] truncate">{children}</span>
      <button
        onClick={onRemove}
        className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-primary/20 hover:text-foreground"
        aria-label={removeLabel ?? t('lists.groupingBar.remove')}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

export function ListGroupingBar({
  groups, sums, groupCount, count, allExpanded,
  onRemoveGroup, onRemoveSum, onToggleExpandAll,
  view = 'nested', onViewChange,
}: ListGroupingBarProps) {
  const { t, locale } = useTranslation();
  const grouped = groups.length > 0;
  const scheduleMode = view === 'schedule';
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b bg-muted/30 px-3 py-1.5 text-xs">
      {grouped && onViewChange && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => onViewChange(scheduleMode ? 'nested' : 'schedule')}
              aria-pressed={scheduleMode}
              aria-label={scheduleMode ? t('lists.groupingBar.switchToNestedAriaLabel') : t('lists.groupingBar.switchToScheduleAriaLabel')}
              className={cn(
                'mr-0.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs hover:bg-muted hover:text-foreground',
                scheduleMode ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              {scheduleMode ? <Table2 className="h-3.5 w-3.5" /> : <ListTree className="h-3.5 w-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{scheduleMode ? t('lists.groupingBar.showingScheduleTooltip') : t('lists.groupingBar.showingNestedTooltip')}</TooltipContent>
        </Tooltip>
      )}
      {grouped && !scheduleMode && (
        <button
          onClick={onToggleExpandAll}
          className="mr-0.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-muted hover:text-foreground"
          title={allExpanded ? t('lists.groupingBar.collapseAllGroups') : t('lists.groupingBar.expandAllGroups')}
        >
          {allExpanded ? <ChevronsDownUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5" />}
        </button>
      )}

      {grouped
        ? groups.map((g, i) => (
            <Chip key={g.id} icon={<Group className="h-3 w-3 text-primary" />} onRemove={() => onRemoveGroup(g.id)} removeLabel={t('lists.groupingBar.removeGroupingByAriaLabel', { label: g.label })}>
              {i === 0 ? t('lists.groupingBar.groupedByChip', { label: g.label }) : t('lists.groupingBar.thenChip', { label: g.label })}
            </Chip>
          ))
        : <span className="text-muted-foreground">{styleInterpolatedValues(t, 'lists.groupingBar.noGrouping', [
          ['menu', <span key="menu" className="font-medium text-foreground">⋮</span>],
        ])}</span>}

      {sums.map((s) => (
        <Chip key={s.id} icon={<Sigma className="h-3 w-3 text-primary" />} onRemove={() => onRemoveSum(s.id)} removeLabel={t('lists.groupingBar.removeSumOfAriaLabel', { label: s.label })}>{s.label}</Chip>
      ))}

      <span className={cn('ml-auto whitespace-nowrap font-medium text-muted-foreground')}>
        {grouped && <>{t('lists.groupingBar.groupCount', { count: groupCount, countDisplay: formatLocaleCount(groupCount, locale) })} · </>}
        {t('lists.groupingBar.elementCount', { count, countDisplay: formatLocaleCount(count, locale) })}
      </span>
    </div>
  );
}
