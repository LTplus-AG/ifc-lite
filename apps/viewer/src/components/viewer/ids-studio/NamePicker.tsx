/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A schema picker (IDS-033/034): a combobox over a pre-indexed option list
 * that may hold a thousand entries or more, so the listbox is virtualised.
 * Typing filters; ↑↓ move, Enter picks the highlighted option or, with none,
 * submits the typed text (the gate then grounds it and suggests candidates).
 */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';

export interface PickerOption {
  value: string;
  /** Secondary text, e.g. the supertype chain or a data type. */
  detail?: string;
  /** Short badges, e.g. "abstract", "applicable". */
  badges?: Array<{ label: string; tone: 'muted' | 'warn' | 'ok' }>;
  /** Shown greyed; still pickable (the gate / lint explains why it is unusual). */
  dim?: boolean;
}

interface NamePickerProps {
  label: string;
  value: string;
  options: readonly PickerOption[];
  onPick: (value: string) => void;
  placeholder?: string;
  /** Controls beside the label (e.g. "show all"). */
  labelAction?: ReactNode;
  emptyText: string;
  disabled?: boolean;
}

const ROW = 30;
const BADGE: Record<'muted' | 'warn' | 'ok', string> = {
  muted: 'border-border text-muted-foreground',
  warn: 'border-amber-500/50 text-amber-700 dark:text-amber-400',
  ok: 'border-emerald-500/50 text-emerald-700 dark:text-emerald-400',
};

export function NamePicker({ label, value, options, onPick, placeholder, labelAction, emptyText, disabled }: NamePickerProps) {
  const id = useId();
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => setQuery(value), [value]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || q === value.toLowerCase()) return options;
    const starts = options.filter((o) => o.value.toLowerCase().startsWith(q));
    const contains = options.filter((o) => !o.value.toLowerCase().startsWith(q) && o.value.toLowerCase().includes(q));
    return [...starts, ...contains];
  }, [options, query, value]);
  const virtualizer = useVirtualizer({ count: open ? filtered.length : 0, getScrollElement: () => listRef.current, estimateSize: () => ROW, overscan: 8 });

  const pick = (next: string) => {
    setOpen(false);
    setHighlight(-1);
    setQuery(next);
    if (next !== value) onPick(next);
  };
  const move = (delta: number) => {
    if (!filtered.length) return;
    setOpen(true);
    const next = Math.max(0, Math.min(filtered.length - 1, highlight + delta));
    setHighlight(next);
    virtualizer.scrollToIndex(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      const option = open && highlight >= 0 ? filtered[highlight] : undefined;
      pick(option ? option.value : query.trim());
    } else if (event.key === 'Escape') {
      if (open) { event.stopPropagation(); setOpen(false); }
      setQuery(value);
    }
  };
  const listId = `${id}-list`;
  const activeId = open && highlight >= 0 ? `${id}-opt-${highlight}` : undefined;
  return <div className="space-y-0.5">
    <div className="flex items-center gap-1">
      <label htmlFor={id} className="flex-1 text-2xs text-muted-foreground">{label}</label>
      {labelAction}
    </div>
    <input id={id} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={activeId}
      className="h-7 w-full rounded border border-input bg-background px-2 text-xs font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
      value={query} placeholder={placeholder} disabled={disabled} autoComplete="off" spellCheck={false}
      onChange={(event) => { setQuery(event.target.value); setOpen(true); setHighlight(-1); }}
      onFocus={() => setOpen(true)}
      onBlur={(event) => { if (!listRef.current?.contains(event.relatedTarget as Node | null)) { setOpen(false); setQuery(value); } }}
      onKeyDown={onKeyDown} />
    {/* Rich rows (badges, supertype chain) over 1k+ virtualised options: a native select cannot render them. */}
    {/* Option clicks are delegated here; focus stays in the combobox (aria-activedescendant). */}
    <div ref={listRef} id={listId}
      // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="listbox" aria-label={label} tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()} onKeyDown={onKeyDown}
      onClick={(event) => {
        const index = (event.target as HTMLElement).closest('[data-option-index]')?.getAttribute('data-option-index');
        const option = index === null || index === undefined ? undefined : filtered[Number(index)];
        if (option) pick(option.value);
      }}
      className={cn('max-h-56 overflow-auto rounded border border-border bg-popover', !open && 'hidden')}>
      {open && filtered.length === 0 && <p className="px-2 py-1.5 text-2xs text-muted-foreground">{emptyText}</p>}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const option = filtered[item.index];
          // Virtualised custom rows; see the listbox note above.
          // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
          return <div key={option.value} id={`${id}-opt-${item.index}`} data-option-index={item.index} role="option" aria-selected={item.index === highlight}
            style={{ position: 'absolute', top: item.start, left: 0, right: 0, height: ROW }}
            className={cn('flex cursor-pointer items-center gap-1.5 px-2 text-xs', item.index === highlight ? 'bg-accent' : 'hover:bg-muted', option.dim && 'text-muted-foreground')}>
            <span className="font-mono truncate">{option.value}</span>
            {option.badges?.map((badge) => <span key={badge.label} className={cn('shrink-0 rounded border px-1 text-2xs', BADGE[badge.tone])}>{badge.label}</span>)}
            {option.detail && <span className="ml-auto truncate text-2xs text-muted-foreground">{option.detail}</span>}
          </div>;
        })}
      </div>
    </div>
  </div>;
}
