/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The inspector's shared building blocks (#8802 R2): one section header, one
 * key/value row and one group label, so attributes, property sets, materials,
 * quantities and the model summary all read as a single table system.
 *
 * - Sections are full-bleed, separated by a hairline, with a 32 px sentence-case
 *   header: chevron, title, muted count.
 * - Rows are 28 px two-column key/value pairs: the key muted, the value regular
 *   weight, ellipsized with the full text in a tooltip and a copy button.
 * - Mono is for identifiers and numbers only; callers opt in with `mono`.
 */

import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { CopyValueButton } from './CopyValueButton';

/** Outer class of a collapsible inspector section (one per pset, material, …). */
export const INSPECTOR_SECTION = 'w-full max-w-full overflow-hidden border-b border-border last:border-b-0';

/** Header row of a collapsible section: 32 px, chevron at the trailing edge. */
export const INSPECTOR_TRIGGER = 'group/disclosure flex h-8 w-full min-w-0 items-center gap-1.5 overflow-hidden px-3 text-left transition-colors hover:bg-muted/60';

/** Title, count and chevron classes for cards that compose their own header. */
export const INSPECTOR_TITLE = 'min-w-0 flex-1 truncate text-xs font-semibold text-foreground';
export const INSPECTOR_COUNT = 'shrink-0 text-2xs tabular-nums text-muted-foreground';
export const INSPECTOR_CHEVRON = 'inspector-chevron size-3.5 shrink-0 text-muted-foreground';
export const INSPECTOR_SUBHEADING = 'mb-0.5 text-2xs font-medium text-muted-foreground';

/** Rows of an open section: a hairline from the header, no inner dividers. */
export const INSPECTOR_ROWS = 'pb-1';

/** Numbers and identifiers (and only those) render in mono. */
const NUMERIC_VALUE = /^[-+−]?(?:\d[\d\s.,'’]*)(?:[eE][-+]?\d+)?(?:\s?[%°]|\s?[a-zA-Zµ²³/]{1,6})?$/;

export function isNumericDisplay(value: string): boolean {
  return NUMERIC_VALUE.test(value.trim());
}

export function InspectorSectionTrigger({ title, count, icon, trailing, className }: {
  title: ReactNode;
  count?: ReactNode;
  icon?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <CollapsibleTrigger className={cn(INSPECTOR_TRIGGER, className)}>
      {icon}
      <span className={INSPECTOR_TITLE}>{title}</span>
      {trailing}
      {count !== undefined && <span className={INSPECTOR_COUNT}>{count}</span>}
      <ChevronDown className={INSPECTOR_CHEVRON} aria-hidden="true" />
    </CollapsibleTrigger>
  );
}

/** A static (non-collapsible) section heading in the same voice. */
export function InspectorHeading({ children, icon, trailing, className }: {
  children: ReactNode;
  icon?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex h-8 min-w-0 items-center gap-1.5 px-3 text-xs font-semibold text-foreground', className)}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </div>
  );
}

/** Muted sub-group label inside a tab ("Type properties · …"). */
export function InspectorGroupLabel({ children, icon, title, as: Tag = 'div' }: { children: ReactNode; icon?: ReactNode; title?: string; as?: 'div' | 'h3' }) {
  return (
    <Tag className="flex h-7 min-w-0 items-center gap-1.5 border-b border-border bg-muted/40 px-3 text-2xs font-medium text-muted-foreground" title={title}>
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </Tag>
  );
}

/**
 * One key/value row. `value` is the displayed text (also the tooltip and the
 * copied text unless `copyValue` says otherwise); `children` replaces the
 * rendered value (an editor, highlighted search text) while keeping the row.
 */
export function InspectorRow({ label, labelNode, labelCell, value, children, mono, copyValue, copy = true, copyLabel, className, valueClassName, rowProps }: {
  label: string;
  labelNode?: ReactNode;
  /** Replaces the whole key cell (a tooltip trigger that must be the cell itself). */
  labelCell?: ReactNode;
  value?: string;
  children?: ReactNode;
  mono?: boolean;
  copyValue?: string;
  copy?: boolean;
  /** Canonical action name for the copy button (#5858), when it has one. */
  copyLabel?: string;
  className?: string;
  valueClassName?: string;
  rowProps?: Record<string, unknown>;
}) {
  const shown = value ?? '';
  const useMono = mono ?? (shown !== '' && isNumericDisplay(shown));
  return (
    <div className={cn('inspector-kv group/copyrow min-h-7 gap-x-2 pl-3 pr-1 text-xs', className)} {...rowProps}>
      {labelCell ?? <span className="min-w-0 truncate text-muted-foreground" title={label}>{labelNode ?? label}</span>}
      <span
        className={cn('min-w-0 truncate text-foreground', useMono && 'font-mono tabular-nums', valueClassName)}
        title={shown || undefined}
      >
        {children ?? shown}
      </span>
      {/* The copy slot is always a cell of its own, button or not. */}
      <span className="flex w-6 justify-center">
        {copy && shown !== '' && <CopyValueButton name={label} value={copyValue ?? shown} actionLabel={copyLabel} />}
      </span>
    </div>
  );
}

export const DISCLOSURE_CHEVRON_CLASSES = 'size-3 transition-transform group-data-[state=closed]/disclosure:-rotate-90';
export const MULTI_SELECTION_TRIGGER_CLASSES = 'group/disclosure flex items-center gap-2 w-full p-2 hover:bg-muted text-left text-xs';
export const MULTI_SELECTION_SECTION_CLASSES = 'border-b border-border';
