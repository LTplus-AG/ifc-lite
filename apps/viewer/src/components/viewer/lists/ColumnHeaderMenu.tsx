/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-column actions menu for the Lists results table header. Brings
 * grouping / aggregation / sorting onto the table itself so the user never
 * has to round-trip through the list settings.
 */

import { ArrowUp, ArrowDown, Group, Ungroup, Sigma, Palette, MoreVertical } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

interface ColumnHeaderMenuProps {
  isNumeric: boolean;
  isGroupedBy: boolean;
  /** Grouping is active on OTHER columns — grouping this one adds a nesting
   *  level (multi-criteria grouping, issue #1790). */
  groupedElsewhere: boolean;
  isSummed: boolean;
  active: boolean;
  onSort: (dir: 'asc' | 'desc') => void;
  onToggleGroup: () => void;
  onToggleSum: () => void;
  onColorBy: () => void;
}

export function ColumnHeaderMenu({
  isNumeric, isGroupedBy, groupedElsewhere, isSummed, active,
  onSort, onToggleGroup, onToggleSum, onColorBy,
}: ColumnHeaderMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label="Column options"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'shrink-0 rounded-sm p-0.5 transition-opacity hover:text-foreground',
            active
              ? 'text-primary opacity-100'
              : 'text-muted-foreground opacity-0 group-hover/col:opacity-100 data-[state=open]:opacity-100',
          )}
        >
          <MoreVertical className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuItem className="gap-2 text-xs" onClick={() => onSort('asc')}>
          <ArrowUp className="h-3.5 w-3.5" /> Sort ascending
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2 text-xs" onClick={() => onSort('desc')}>
          <ArrowDown className="h-3.5 w-3.5" /> Sort descending
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2 text-xs" onClick={onToggleGroup}>
          {isGroupedBy
            ? (<><Ungroup className="h-3.5 w-3.5" /> Remove from grouping</>)
            : groupedElsewhere
              ? (<><Group className="h-3.5 w-3.5" /> Add grouping level</>)
              : (<><Group className="h-3.5 w-3.5" /> Group by this column</>)}
        </DropdownMenuItem>
        <DropdownMenuCheckboxItem
          className="text-xs"
          checked={isSummed}
          disabled={!isNumeric}
          onCheckedChange={onToggleSum}
        >
          <span className="flex items-center gap-2">
            <Sigma className="h-3.5 w-3.5" />
            {isNumeric ? 'Sum / total this column' : 'Sum (numeric only)'}
          </span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2 text-xs" onClick={onColorBy}>
          <Palette className="h-3.5 w-3.5" /> Colour by this column
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
