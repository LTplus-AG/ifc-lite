/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '@/lib/utils';
import { capturePointer, releasePointer } from '@/lib/pointer-capture';

export interface HudValueFieldProps {
  value: number;
  onChange: (next: number) => void;
  /** Displayed after the number, e.g. "m" — never localized here, the
   *  caller passes the already-translated unit string. */
  unit?: string;
  /** Amount one arrow-key press or one `scrubSensitivity`-px drag moves. */
  step?: number;
  /** Multiplier applied to `step` while Shift is held. */
  shiftMultiplier?: number;
  min?: number;
  max?: number;
  /** Decimal places shown both at rest and while scrubbing. */
  precision?: number;
  /** Pixels of horizontal pointer movement per `step` while dragging. */
  scrubSensitivity?: number;
  /** Accessible name — required, caller-supplied and translated. */
  'aria-label': string;
  className?: string;
}

const DEFAULT_SCRUB_SENSITIVITY = 6;
/** Drags shorter than this many px are treated as a click, not a scrub. */
const CLICK_SLOP_PX = 2;

/**
 * A scrubbable number with a unit (#5478 §6's distance field, replacing a
 * slider inside an expanding form): drag horizontally to scrub, click (or
 * Enter/Space) to type a value directly, arrow keys to step — the same
 * three interactions in one control instead of a slider plus a separate
 * numeric field. Exposed as `role="spinbutton"` with a live `aria-valuetext`
 * (value + unit together, so a screen reader announces "1.20 m", not just
 * "1.2") when at rest, and a plain text `<input>` while editing.
 */
export function HudValueField({
  value,
  onChange,
  unit = '',
  step = 1,
  shiftMultiplier = 10,
  min = -Infinity,
  max = Infinity,
  precision = 2,
  scrubSensitivity = DEFAULT_SCRUB_SENSITIVITY,
  className,
  ...aria
}: HudValueFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const dragRef = useRef<{ pointerId: number; startX: number; startValue: number; moved: boolean } | null>(
    null,
  );

  const clamp = (next: number): number => Math.min(max, Math.max(min, next));

  function startEdit(): void {
    setDraft(value.toFixed(precision));
    setEditing(true);
  }

  function commitDraft(): void {
    const parsed = Number.parseFloat(draft);
    if (Number.isFinite(parsed)) onChange(clamp(parsed));
    setEditing(false);
  }

  function handlePointerDown(e: PointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return;
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startValue: value, moved: false };
    capturePointer(e.currentTarget, e.pointerId);
  }

  function handlePointerMove(e: PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    if (Math.abs(dx) > CLICK_SLOP_PX) drag.moved = true;
    const steps = Math.trunc(dx / scrubSensitivity);
    const next = clamp(drag.startValue + steps * step);
    if (next !== value) onChange(next);
  }

  function endDrag(e: PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    releasePointer(e.currentTarget, e.pointerId);
    // A press-release that never crossed the slop threshold is a click:
    // fall into type-to-set rather than leaving the user no way to open it
    // from a pointer.
    if (!drag.moved) startEdit();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    const mult = e.shiftKey ? shiftMultiplier : 1;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      e.preventDefault();
      onChange(clamp(value + step * mult));
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      onChange(clamp(value - step * mult));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      startEdit();
    }
  }

  function handleInputKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitDraft();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <input
        type="text"
        inputMode="decimal"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleInputKeyDown}
        onBlur={commitDraft}
        aria-label={aria['aria-label']}
        className={cn(
          'w-16 rounded-sm border border-border bg-background px-1 py-0.5 text-xs tabular-nums outline-none focus:ring-1 focus:ring-ring',
          className,
        )}
      />
    );
  }

  return (
    <div
      role="spinbutton"
      tabIndex={0}
      aria-label={aria['aria-label']}
      aria-valuenow={value}
      aria-valuemin={Number.isFinite(min) ? min : undefined}
      aria-valuemax={Number.isFinite(max) ? max : undefined}
      aria-valuetext={`${value.toFixed(precision)}${unit}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      className={cn(
        'inline-flex cursor-ew-resize select-none items-center gap-0.5 rounded-sm px-1 py-0.5 text-xs tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-ring',
        className,
      )}
    >
      <span>{value.toFixed(precision)}</span>
      {unit && <span className="text-muted-foreground">{unit}</span>}
    </div>
  );
}
