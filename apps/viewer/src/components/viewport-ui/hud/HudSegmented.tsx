/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface HudSegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  /** Overrides `label` for the accessible name when `label` is icon-only. */
  ariaLabel?: string;
  /** Hover tooltip, e.g. what an angle kind asks the user to click. Translated by the caller. */
  title?: string;
}

export interface HudSegmentedProps<T extends string> {
  options: ReadonlyArray<HudSegmentedOption<T>>;
  value: T;
  onChange: (next: T) => void;
  /** Accessible name for the group, e.g. "Section axis". Caller-supplied and
   *  translated — this component carries no strings of its own. */
  'aria-label': string;
  className?: string;
}

/**
 * A segmented control — e.g. the Section bar's Down / Front / Side / ⌖ Face
 * axis choice (#5478 §6), one control replacing what was a separate mode
 * plus a differently-coloured "custom" variant.
 */
export function HudSegmented<T extends string>({
  options,
  value,
  onChange,
  className,
  ...rest
}: HudSegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={rest['aria-label']}
      className={cn('inline-flex items-center gap-0.5', className)}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.ariaLabel}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs transition-colors',
              active
                ? 'bg-overlay-accent-soft text-overlay-accent'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
