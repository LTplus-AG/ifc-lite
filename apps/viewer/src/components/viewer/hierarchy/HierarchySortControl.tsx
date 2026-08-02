/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sort-order selector for the spatial browser (issue #1296). The tree defaults
 * to elevation order (the top-down building stack), which reads as arbitrary
 * when storey names don't track height; this lets the user switch to an
 * alphanumeric (natural-numeric) name sort, in either direction.
 *
 * A name sort applies at every spatial level — storey rows AND the elements
 * inside each storey (issue #1476), so it stays useful even when a model has a
 * single storey. Elevation modes reorder only the storey stack; elements keep
 * their as-modeled document order (they carry no elevation).
 *
 * Only meaningful in the spatial grouping mode — the Class / Type / Material
 * trees are already name-sorted — so the panel renders it just for `spatial`.
 */

import { ChevronDown, ArrowDownWideNarrow, ArrowUpWideNarrow, ArrowDownAZ, ArrowUpAZ } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { HierarchySortMode } from './types';

const SORT_OPTIONS: ReadonlyArray<{
  value: HierarchySortMode;
  /** Short word for the trigger; the icon carries the direction. */
  short: string;
  label: string;
  Icon: typeof ArrowDownWideNarrow;
}> = [
  { value: 'elevation-desc', short: 'Elevation', label: 'Elevation, high to low', Icon: ArrowDownWideNarrow },
  { value: 'elevation-asc', short: 'Elevation', label: 'Elevation, low to high', Icon: ArrowUpWideNarrow },
  { value: 'name-asc', short: 'Name', label: 'Name, A to Z', Icon: ArrowDownAZ },
  { value: 'name-desc', short: 'Name', label: 'Name, Z to A', Icon: ArrowUpAZ },
];

interface HierarchySortControlProps {
  value: HierarchySortMode;
  onChange: (mode: HierarchySortMode) => void;
}

export function HierarchySortControl({ value, onChange }: HierarchySortControlProps) {
  const active = SORT_OPTIONS.find((o) => o.value === value) ?? SORT_OPTIONS[0];
  const ActiveIcon = active.Icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-6 w-full justify-between gap-1 px-2 mt-1 text-[10px] rounded-none uppercase tracking-wider"
          title="Sort the spatial browser (storeys and their contents)"
        >
          <span className="flex items-center gap-1 min-w-0">
            <ActiveIcon className="h-3 w-3 shrink-0" />
            <span className="truncate">Sort: {active.short}</span>
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[11rem]">
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as HierarchySortMode)}>
          {SORT_OPTIONS.map(({ value: optValue, label, Icon }) => (
            <DropdownMenuRadioItem key={optValue} value={optValue} className="text-xs gap-2">
              <Icon className="h-3.5 w-3.5 shrink-0" />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
