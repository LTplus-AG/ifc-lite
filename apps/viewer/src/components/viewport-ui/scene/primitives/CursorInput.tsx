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

import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useSceneLayer } from '../SceneLayers';
import { useWorldAnchor } from '../useWorldAnchor';
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
}: CursorInputProps) {
  const domLayer = useSceneLayer('dom');
  const { ref } = useWorldAnchor<HTMLDivElement>(() => worldPoint);

  if (!domLayer) return null;

  return createPortal(
    <div
      ref={ref}
      style={{ display: 'none' }}
      data-scene-primitive="cursor-input"
      className="pointer-events-none absolute left-0 top-0 will-change-transform"
    >
      <div className={cn(CARD_SURFACE, 'pointer-events-auto p-1')} style={{ transform: `translate(${offset.dx}px, ${offset.dy}px)` }}>
        <input
          type="text"
          inputMode="decimal"
          value={value}
          placeholder={placeholder}
          aria-label={ariaLabel}
          autoFocus
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
          onBlur={() => onCommit(value)}
        />
      </div>
    </div>,
    domLayer,
  );
}
