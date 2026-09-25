/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `CursorInput`: a small numeric/text entry anchored to a world point —
 * the split tool's numeric length entry, a scrubbable distance field
 * planted where the user is working instead of in a floating form. Commits
 * on Enter/blur, cancels on Escape; `tabular-nums` like every other
 * on-screen number in this system.
 */

import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useSceneLayer } from '../SceneLayers';
import { useWorldAnchor } from '../useWorldAnchor';
import { isAnchorVisible } from '../projection';
import type { Vec3 } from '../types';

export interface CursorInputProps {
  worldPoint: Vec3 | null;
  value: string;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
  onCancel?: () => void;
  offset?: { dx: number; dy: number };
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  /**
   * Whether losing focus commits the draft (default `true`, the
   * `HudValueField` convention). A caller whose commit is a destructive
   * edit — the Split tool cuts an element — passes `false`: there the same
   * click that blurs the input also performs the click-split, and a blur
   * commit on top of it would cut twice.
   */
  commitOnBlur?: boolean;
  /**
   * Focus the input as soon as it is first projected on screen (default
   * `true`) so "hover, type, Enter" needs no click. Not the DOM `autoFocus`
   * attribute: that fires on mount, while the anchor is still
   * `display: none` waiting for its first projection, and focusing a hidden
   * element is a no-op in a real browser (#5503, measured: focus stayed on
   * the canvas).
   */
  autoFocus?: boolean;
  /** Optional trailing unit caption, e.g. "m". Caller-translated. */
  unit?: string;
}

const CARD_SURFACE = 'bg-popover/94 backdrop-blur-md border border-border rounded-md shadow-sm';

export function CursorInput({
  worldPoint,
  value,
  onChange,
  onCommit,
  onCancel,
  offset = { dx: 14, dy: 14 },
  placeholder,
  ariaLabel,
  className,
  commitOnBlur = true,
  autoFocus = true,
  unit,
}: CursorInputProps) {
  const domLayer = useSceneLayer('dom');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const focusedOnceRef = useRef(false);
  const { ref } = useWorldAnchor<HTMLDivElement>(() => worldPoint, {
    onProject: (projection) => {
      if (!autoFocus || focusedOnceRef.current || !isAnchorVisible(projection)) return;
      focusedOnceRef.current = true;
      inputRef.current?.focus({ preventScroll: true });
    },
  });

  if (!domLayer) return null;

  return createPortal(
    <div
      ref={ref}
      style={{ display: 'none' }}
      data-scene-primitive="cursor-input"
      className="pointer-events-none absolute left-0 top-0 will-change-transform"
    >
      <div
        className={cn(CARD_SURFACE, 'pointer-events-auto flex items-center p-1')}
        style={{ transform: `translate(${offset.dx}px, ${offset.dy}px)` }}
      >
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          value={value}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className={cn(
            'w-20 rounded-sm border border-transparent bg-transparent px-1.5 py-0.5 text-xs tabular-nums text-overlay-ink outline-none focus:border-overlay-accent',
            className,
          )}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onCommit(value);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onCancel?.();
            }
          }}
          onBlur={commitOnBlur ? () => onCommit(value) : undefined}
        />
        {unit && <span className="pr-1 text-xs text-overlay-ink-muted">{unit}</span>}
      </div>
    </div>,
    domLayer,
  );
}
