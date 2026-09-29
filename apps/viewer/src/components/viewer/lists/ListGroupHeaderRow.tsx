/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One group header of the nested results tree (#6368). Two controls, as in the
 * Hierarchy panel: the chevron expands and collapses, and the rest of the row
 * is a button that selects every member of the group (sub-group descendants
 * included). A plain click never isolates or X-rays anything.
 *
 * The chevron sits over the row's leading padding instead of inside the select
 * button, because a button may not contain another interactive element.
 */

import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ColumnDefinition } from '@ifc-lite/lists';
import type { SelectModifiers } from '@/hooks/useEntityListMultiSelect';
import { useTranslation } from '@/i18n/useTranslation';
import { cn } from '@/lib/utils';
import { formatLocaleCount } from './formatLocaleCount';
import { formatCellValue, type DisplayItem } from './list-table-utils';

type GroupItem = Extract<DisplayItem, { kind: 'group' }>;

/** Chevron hit target: a 14px icon plus 5px padding a side = 24px (WCAG 2.2 2.5.8). */
const CHEVRON_PX = 24;
/** Sub-groups indent one step per nesting level (#1790). */
const LEVEL_INDENT_PX = 14;

interface ListGroupHeaderRowProps {
  item: GroupItem;
  expanded: boolean;
  selected: boolean;
  columns: ColumnDefinition[];
  columnWidths: number[];
  sumColumnIds: string[];
  transform: string;
  onToggleExpand: (key: string) => void;
  onSelect: (modifiers: SelectModifiers) => void;
}

export function ListGroupHeaderRow({
  item, expanded, selected, columns, columnWidths, sumColumnIds, transform, onToggleExpand, onSelect,
}: ListGroupHeaderRowProps) {
  const { t, locale } = useTranslation();
  const indent = 2 + item.level * LEVEL_INDENT_PX;
  return (
    <div className="absolute left-0 top-0 flex w-full" style={{ transform }}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={t(expanded ? 'lists.resultsTable.collapseGroupAriaLabel' : 'lists.resultsTable.expandGroupAriaLabel', { name: item.label })}
        className="absolute top-1/2 z-[1] -translate-y-1/2 rounded-sm p-[5px] text-muted-foreground hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        style={{ left: indent }}
        onClick={() => onToggleExpand(item.key)}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        aria-pressed={selected}
        className={cn(
          'flex w-full cursor-pointer select-none border-b border-border/40 bg-muted/50 text-left hover:bg-muted/70',
          selected && 'bg-primary/15 hover:bg-primary/20',
        )}
        // Keyboard activation keeps its modifiers (a synthesized click may not).
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(event); }
        }}
        onClick={(event) => onSelect(event)}
      >
        {columns.map((col, colIdx) => (
          <span
            key={col.id}
            className="flex items-center gap-1 border-r border-border/20 px-2 py-1 text-xs font-medium shrink-0"
            style={{ width: columnWidths[colIdx], ...(colIdx === 0 ? { paddingLeft: indent + CHEVRON_PX + 2 } : undefined) }}
          >
            {colIdx === 0 && (
              <>
                <span className="truncate" title={item.label}>{item.label}</span>
                <span className="ml-1 shrink-0 rounded-full bg-foreground/10 px-1.5 text-2xs tabular-nums text-muted-foreground">{formatLocaleCount(item.count, locale)}</span>
              </>
            )}
            {sumColumnIds.includes(col.id) && (
              <span className="ml-auto font-mono tabular-nums">{formatCellValue(item.sums[col.id])}</span>
            )}
          </span>
        ))}
      </button>
    </div>
  );
}
