/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one empty state of a tool panel (#5612, restyled for #8802 R3a): a
 * neutral glyph in an outlined tile, a sentence-case title, one line of
 * explanation, and the panel's way forward (one primary button, at most one
 * quieter companion).
 *
 * The glyph is muted in both themes. An empty list is not a warning, so an
 * empty state never carries status colour; a result that failed or found
 * problems uses `ResultState` instead.
 *
 * `align="start"` sits the state at the top of its region, directly under
 * the panel's controls, instead of centring it in the space left below them.
 */

import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  /** Centre in the region (a whole empty panel), or sit at its top under the controls above it. */
  align?: 'center' | 'start';
  className?: string;
}

export function EmptyState({ icon, title, description, action, align = 'center', className, ...rest }: EmptyStateProps) {
  return (
    <div
      data-empty-state=""
      className={cn(
        'flex flex-col items-center px-6 text-center',
        align === 'center' ? 'justify-center py-8' : 'justify-start pb-6 pt-8',
        className,
      )}
      {...rest}
    >
      <div
        aria-hidden="true"
        className="mb-3 flex size-10 items-center justify-center rounded-md border border-border text-muted-foreground [&>svg]:size-5"
      >
        {icon}
      </div>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description && <p className="mt-1 max-w-64 text-xs text-muted-foreground">{description}</p>}
      {action && <div className="mt-4 flex flex-col items-center gap-2">{action}</div>}
    </div>
  );
}
