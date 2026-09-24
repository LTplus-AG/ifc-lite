/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `WorldLabel`: a small text label anchored to a world point — measurement
 * readouts, dimension text, cut-line labels. Ink when passive (a finished
 * measurement, a parked cut), accent when it's the thing being manipulated
 * right now (§3.1 of the roadmap: calm by default, loud only when acting).
 * `tabular-nums` because every number in this system aligns on the digit
 * grid, and this is the one card surface every anchored label shares.
 */

import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useSceneLayer } from '../SceneLayers';
import { useWorldAnchor } from '../useWorldAnchor';
import type { Vec3 } from '../types';

export interface WorldLabelProps {
  worldPoint: Vec3 | null;
  /** Accent text on an accent-bordered card when true (the light accent alone fails 4.5:1 text contrast — see overlay-theme.ts); ink otherwise. */
  active?: boolean;
  /** CSS px offset from the projected point to the label's top-left. Default centres just above the anchor. */
  offset?: { dx: number; dy: number };
  className?: string;
  children: React.ReactNode;
}

const CARD_SURFACE = 'bg-popover/94 backdrop-blur-md border rounded-md shadow-sm';

export function WorldLabel({ worldPoint, active = false, offset = { dx: 8, dy: -10 }, className, children }: WorldLabelProps) {
  const domLayer = useSceneLayer('dom');
  const { ref } = useWorldAnchor<HTMLDivElement>(() => worldPoint);

  if (!domLayer) return null;

  return createPortal(
    // The OUTER div's `transform` is owned by `useWorldAnchor` (rewritten
    // every dirty tick) — the static label offset must live on a nested
    // element, or the per-frame `translate(screenX, screenY)` write would
    // clobber it every tick.
    <div
      ref={ref}
      style={{ display: 'none' }}
      data-scene-primitive="world-label"
      className="pointer-events-none absolute left-0 top-0 will-change-transform"
    >
      <div
        className={cn(
          CARD_SURFACE,
          'whitespace-nowrap px-1.5 py-0.5 text-xs tabular-nums',
          active ? 'border-overlay-accent text-overlay-ink' : 'border-border text-overlay-ink',
          className,
        )}
        style={{ transform: `translate(${offset.dx}px, ${offset.dy}px)` }}
      >
        {children}
      </div>
    </div>,
    domLayer,
  );
}
