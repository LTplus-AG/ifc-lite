/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `AnchoredCard`: the same card surface as `WorldLabel`, but a free-form
 * container instead of a text-only label — a small readout cluster
 * (coordinates, snap state) pinned next to a world point. It is
 * `pointer-events-auto` (unlike every other primitive here) because a card
 * can host interactive content; `WorldLabel` stays inert.
 */

import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useSceneLayer } from '../SceneLayers';
import { useWorldAnchor } from '../useWorldAnchor';
import type { Vec3 } from '../types';

export interface AnchoredCardProps {
  worldPoint: Vec3 | null;
  offset?: { dx: number; dy: number };
  className?: string;
  children: React.ReactNode;
}

const CARD_SURFACE = 'bg-popover/94 backdrop-blur-md border border-border rounded-md shadow-sm';

export function AnchoredCard({ worldPoint, offset = { dx: 12, dy: 12 }, className, children }: AnchoredCardProps) {
  const domLayer = useSceneLayer('dom');
  const { ref } = useWorldAnchor<HTMLDivElement>(() => worldPoint);

  if (!domLayer) return null;

  return createPortal(
    <div
      ref={ref}
      style={{ display: 'none' }}
      data-scene-primitive="anchored-card"
      className="pointer-events-none absolute left-0 top-0 will-change-transform"
    >
      <div
        className={cn(CARD_SURFACE, 'pointer-events-auto p-2 text-xs text-overlay-ink', className)}
        style={{ transform: `translate(${offset.dx}px, ${offset.dy}px)` }}
      >
        {children}
      </div>
    </div>,
    domLayer,
  );
}
