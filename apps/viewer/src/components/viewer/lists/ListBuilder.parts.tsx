/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The list builder's two presentational shells, split out of
 * `ListBuilder.tsx` (which carries a recorded budget in
 * `scripts/module-size-allowlist.txt`) so the model tag scope editor (#4215)
 * can share the same `Chip` and sit in the same `Section` as the entity-type
 * chips.
 */

import type React from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/** Section shell — consistent header with an accent rule. */
export function Section({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <span className="h-3 w-1 rounded-full bg-primary/70" aria-hidden />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        {hint !== undefined && (
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">{hint}</Badge>
        )}
      </div>
      {children}
    </section>
  );
}

/** A toggleable pill with an optional trailing count. */
export function Chip({
  selected,
  onClick,
  trailing,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
        selected
          ? 'border-primary bg-primary text-primary-foreground shadow-sm'
          : 'border-border bg-background hover:bg-muted',
      )}
    >
      {children}
      {trailing !== undefined && (
        <span className={cn('tabular-nums', selected ? 'opacity-80' : 'text-muted-foreground')}>{trailing}</span>
      )}
    </button>
  );
}
