/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ComboInput — a free-text input that opens a suggestion dropdown on focus
 * and filters it as you type. Pick a suggestion or keep typing anything;
 * the value is never restricted to the options. Used by the filter chip
 * editors to surface real model values (materials, classifications,
 * property values, pset/qto names) without hiding them behind a tiny chevron.
 *
 * The list is portaled to `document.body` and fixed-positioned under the
 * input so it's never clipped by the modal's scroll container, and it
 * follows the input on scroll / resize.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface ComboInputProps {
  value: string;
  onChange: (next: string) => void;
  options: ReadonlyArray<string>;
  placeholder?: string;
  className?: string;
  /** Cap rendered suggestions (filtering still scans all options). */
  maxRendered?: number;
  'aria-label'?: string;
}

interface Anchor { left: number; top: number; width: number }

export function ComboInput({
  value,
  onChange,
  options,
  placeholder,
  className,
  maxRendered = 50,
  'aria-label': ariaLabel,
}: ComboInputProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    const matches = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
    return matches.slice(0, maxRendered);
  }, [options, value, maxRendered]);

  useEffect(() => { setHighlight(0); }, [filtered]);

  const reposition = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchor({ left: r.left, top: r.bottom, width: r.width });
  }, []);

  // Track the input's position while open (capture = also catch ancestor
  // scrolls inside the modal), and close on outside pointer-down / Escape.
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onScroll = () => reposition();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (inputRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open, reposition]);

  const showList = open && filtered.length > 0 && anchor !== null;

  const commit = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <>
      <Input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setHighlight((h) => Math.min(h + 1, filtered.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === 'Enter') {
            if (showList && filtered[highlight] !== undefined) {
              e.preventDefault();
              commit(filtered[highlight]);
            }
          } else if (e.key === 'Escape') {
            if (open) { e.stopPropagation(); setOpen(false); }
          }
        }}
        className={className}
        autoComplete="off"
        role="combobox"
        aria-expanded={showList}
        aria-label={ariaLabel}
      />
      {showList && createPortal(
        <div
          ref={listRef}
          role="listbox"
          // Portaled to <body>, which sits OUTSIDE the Radix Dialog. Radix's
          // scroll-lock disables pointer events on everything outside the
          // dialog, so re-enable them here or mouse clicks/scroll are dead.
          // Stop pointerdown from bubbling to the dialog's dismissable layer
          // so selecting a value doesn't also close the whole modal.
          style={{ position: 'fixed', left: anchor.left, top: anchor.top + 4, minWidth: anchor.width, pointerEvents: 'auto' }}
          onPointerDown={(e) => e.stopPropagation()}
          className="z-[120] max-h-60 w-max max-w-[20rem] overflow-y-auto rounded-md border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950"
        >
          {filtered.map((o, i) => (
            <button
              key={o}
              type="button"
              role="option"
              aria-selected={i === highlight}
              // mousedown (not click) so the input doesn't blur-close first.
              onMouseDown={(e) => { e.preventDefault(); commit(o); }}
              onMouseEnter={() => setHighlight(i)}
              className={cn(
                'block w-full truncate px-2 py-1 text-left text-xs font-mono',
                i === highlight
                  ? 'bg-zinc-100 dark:bg-zinc-800'
                  : 'hover:bg-zinc-50 dark:hover:bg-zinc-900',
              )}
              title={o}
            >
              {o}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
