/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An active filter, named, with its own clear button (#8802 R4). It wears
 * the shared active state (tinted surface, active ink, an inset active edge)
 * so a narrowed view reads as a state that is on, not as inert text. The
 * edge is an inset ring, so the chip is no larger than plain text chips.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface FilterChipProps {
  children: ReactNode;
  onClear: () => void;
  /** Accessible name of the clear button; it names the filter it clears. */
  clearLabel: string;
  className?: string;
}

export function FilterChip({ children, onClear, clearLabel, className }: FilterChipProps) {
  return (
    <span
      data-filter-chip=""
      className={cn(
        'inline-flex items-center gap-1 rounded-sm bg-active-surface px-1.5 py-0.5 text-2xs font-medium text-active ring-1 ring-inset ring-active-border',
        className,
      )}
    >
      {children}
      <button type="button" onClick={onClear} aria-label={clearLabel} className="ml-0.5 text-xs leading-none text-active hover:text-foreground">
        &times;
      </button>
    </span>
  );
}
