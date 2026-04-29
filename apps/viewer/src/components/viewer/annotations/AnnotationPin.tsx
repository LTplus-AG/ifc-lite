/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Single annotation pin — a 14px circle anchored to a screen point.
 *
 * The dot itself is small; we wrap it in a 24×24 invisible hit-target
 * so it stays comfortable on touch and doesn't fight pointer events
 * on the surrounding canvas. The pin sits in the canvas overlay layer
 * (`AnnotationLayer`) which positions it absolutely each frame.
 */

import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

export interface AnnotationPinProps {
  /** Index in the rendered list — 1-based. Shown inside the dot when ≤ 9. */
  index: number;
  /** Highlights the dot with the emerald ring used for selection across the viewer. */
  selected?: boolean;
  /** Tooltip preview when the user hovers (author + first ~40 chars of note). */
  preview?: string;
  /** Called when the dot is clicked. */
  onClick?: () => void;
  /** Called when the dot is right-clicked — used by the layer for "delete via menu". */
  onContextMenu?: (e: React.MouseEvent) => void;
  /** Visual variant. `draft` is a slightly washed-out pin used while the note input is open. */
  variant?: 'idle' | 'draft';
}

export const AnnotationPin = forwardRef<HTMLButtonElement, AnnotationPinProps>(
  function AnnotationPin({ index, selected, preview, onClick, onContextMenu, variant = 'idle' }, ref) {
    // 1-character glyph: the index for ≤ 9, ellipsis otherwise. Keeps
    // the pin readable at 14px without feeling crowded.
    const glyph = index <= 9 ? String(index) : '·';

    return (
      <button
        ref={ref}
        type="button"
        title={preview}
        onClick={onClick}
        onContextMenu={onContextMenu}
        className={cn(
          // 24×24 invisible hit-target around a 14px dot — touch comfort
          // without bloating the visual.
          'group relative inline-flex h-6 w-6 items-center justify-center',
          'cursor-pointer outline-none focus-visible:outline-none',
        )}
      >
        <span
          aria-hidden
          className={cn(
            // Inner dot: 14px disc, amber accent, white glyph centered.
            // Drop shadow grounds it against the rendered scene; without
            // it the pin floats and reads as a UI bug.
            'flex h-3.5 w-3.5 items-center justify-center rounded-full',
            'text-[8px] font-mono font-bold leading-none text-white tabular-nums',
            'shadow-[0_1px_4px_rgba(0,0,0,0.35),0_0_0_1px_rgba(0,0,0,0.15)]',
            'transition-transform duration-150 ease-out',
            'group-hover:scale-[1.18]',
            // Idle pulse on first paint — drawn from the layer's
            // animation-delay so a freshly committed pin announces
            // itself once and then settles.
            variant === 'idle' && 'annotation-pin-idle',
            variant === 'draft' && 'opacity-70',
          )}
          style={{
            backgroundColor: variant === 'draft' ? '#fbbf24' : '#f59e0b',
          }}
        >
          {glyph}
        </span>
        {selected && (
          <span
            aria-hidden
            // Selection ring — emerald, matches the existing
            // "constructive" accent (Raw STEP nav, duplicate path).
            // Sits one pixel outside the dot via `ring-offset`.
            className="pointer-events-none absolute inset-[5px] rounded-full ring-2 ring-emerald-500 ring-offset-1 ring-offset-transparent"
          />
        )}
      </button>
    );
  },
);
