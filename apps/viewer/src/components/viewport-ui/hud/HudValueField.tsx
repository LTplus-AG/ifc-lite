/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type PointerEvent, type Ref } from 'react';
import { cn } from '@/lib/utils';
import { capturePointer, releasePointer } from '@/lib/pointer-capture';

/** Opens the field for typing from outside: Tab-through, "type a digit to start". */
export interface HudValueFieldHandle {
  /** Enter type-to-set mode; `draft` replaces the shown value (a typed first digit). */
  beginEdit(draft?: string): void;
}

export interface HudValueFieldProps {
  ref?: Ref<HudValueFieldHandle>;
  value: number;
  disabled?: boolean;
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
  /**
   * Values a pointer scrub snaps onto when it lands within `snapTolerance`
   * of one — the Section bar's storey elevations (#5499). Only a scrub
   * snaps: a typed value and an arrow-key step are the precise paths, and a
   * step that snapped back into the catchment it just left would never
   * escape it.
   */
  snaps?: readonly number[];
  /** Half-width of each snap's catchment, in value units. */
  snapTolerance?: number;
  /** Fires once when a pointer scrub starts moving (not on a plain click). */
  onScrubStart?: () => void;
  /** Fires when a scrub that fired `onScrubStart` ends or is cancelled. */
  onScrubEnd?: () => void;
  /** Enter in the text input: fires after `onChange` with the typed value. */
  onSubmit?: (value: number) => void;
  /** Tab in the text input: the typed value is applied, then this fires (the caller moves focus). */
  onTab?: (shift: boolean) => void;
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
  ref,
  value,
  disabled = false,
  onChange,
  unit = '',
  step = 1,
  shiftMultiplier = 10,
  min = -Infinity,
  max = Infinity,
  precision = 2,
  scrubSensitivity = DEFAULT_SCRUB_SENSITIVITY,
  snaps,
  snapTolerance = 0,
  onScrubStart,
  onScrubEnd,
  onSubmit,
  onTab,
  className,
  ...aria
}: HudValueFieldProps) {
  const [editing, setEditing] = useState(false);
  // What `toFixed` would print as "-0.00" (a face-picked plane a hair below
  // its face, #5480's inset) is zero to the user.
  const shown = Math.abs(value) < 0.5 * 10 ** -precision ? 0 : value;
  const [draft, setDraft] = useState('');
  // Whether the user typed into this edit session. Only a typed draft
  // commits: a field opened by Tab (or a click) and left untouched keeps its
  // value, so blurring it — say, by clicking in the viewport — writes nothing.
  const typed = useRef(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startValue: number; moved: boolean } | null>(
    null,
  );

  const controlRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!disabled) return;
    const drag = dragRef.current;
    if (drag && controlRef.current) releasePointer(controlRef.current, drag.pointerId);
    dragRef.current = null;
    if (drag?.moved) onScrubEnd?.();
    typed.current = false; setEditing(false);
  }, [disabled, onScrubEnd]);

  const clamp = (next: number): number => Math.min(max, Math.max(min, next));
  // Nearest snap wins when several catchments overlap; outside every
  // catchment the value passes through untouched.
  const snap = (next: number): number => {
    if (!snaps || snaps.length === 0 || snapTolerance <= 0) return next;
    let best = next;
    let bestDist = snapTolerance;
    for (const s of snaps) {
      const d = Math.abs(s - next);
      if (d <= bestDist) { best = s; bestDist = d; }
    }
    return best;
  };

  function startEdit(initial?: string): void {
    if (disabled) return;
    setDraft(initial ?? value.toFixed(precision));
    // A caller-supplied draft is a digit the user typed elsewhere.
    typed.current = initial !== undefined;
    setEditing(true);
  }

  useImperativeHandle(ref, () => ({ beginEdit: startEdit }));

  /** The typed value, clamped; null when the draft is not a number or was never typed. */
  function commitDraft(): number | null {
    setEditing(false);
    if (disabled || !typed.current) return null;
    typed.current = false;
    const parsed = Number.parseFloat(draft);
    const next = Number.isFinite(parsed) ? clamp(parsed) : null;
    if (next !== null) onChange(next);
    return next;
  }

  function handlePointerDown(e: PointerEvent<HTMLDivElement>): void {
    if (disabled || e.button !== 0) return;
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startValue: value, moved: false };
    capturePointer(e.currentTarget, e.pointerId);
  }

  function handlePointerMove(e: PointerEvent<HTMLDivElement>): void {
    if (disabled) return;
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    if (Math.abs(dx) > CLICK_SLOP_PX && !drag.moved) {
      drag.moved = true;
      onScrubStart?.();
    }
    const steps = Math.trunc(dx / scrubSensitivity);
    const next = clamp(snap(drag.startValue + steps * step));
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
    else onScrubEnd?.();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (disabled) return;
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
    if (disabled) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const wasTyped = typed.current;
      const next = commitDraft();
      // Enter on an untouched field still submits, with the value as shown.
      if (next !== null || !wasTyped) onSubmit?.(next ?? value);
    } else if (e.key === 'Tab' && onTab) {
      e.preventDefault();
      commitDraft();
      onTab(e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      typed.current = false;
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <input
        disabled={disabled}
        type="text"
        inputMode="decimal"
        autoFocus
        value={draft}
        onChange={(e) => { typed.current = true; setDraft(e.target.value); }}
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
      ref={controlRef}
      role="spinbutton"
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      aria-label={aria['aria-label']}
      aria-valuenow={value}
      aria-valuemin={Number.isFinite(min) ? min : undefined}
      aria-valuemax={Number.isFinite(max) ? max : undefined}
      aria-valuetext={`${shown.toFixed(precision)}${unit}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      className={cn(
        'inline-flex cursor-ew-resize select-none items-center gap-0.5 rounded-sm px-1 py-0.5 text-xs tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-ring',
        disabled && 'cursor-default opacity-50',
        className,
      )}
    >
      <span>{shown.toFixed(precision)}</span>
      {unit && <span className="text-muted-foreground">{unit}</span>}
    </div>
  );
}
