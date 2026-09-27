/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Leader`: a thin line from a world anchor out to a label offset in
 * screen px — the dimension/annotation callout pattern. Passive by
 * default (ink); pass `active` for the one thing currently being drawn.
 */

import { createPortal } from 'react-dom';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useSceneLayer } from '../SceneLayers';
import { useWorldAnchor } from '../useWorldAnchor';
import { isAnchorVisible } from '../projection';
import type { AnchorProjection, Vec3 } from '../types';

export interface LeaderProps {
  worldPoint: Vec3 | null;
  /** Where the label sits relative to the anchor, in CSS px. */
  offset: { dx: number; dy: number };
  active?: boolean;
  className?: string;
}

export function Leader({ worldPoint, offset, active = false, className }: LeaderProps) {
  const svgLayer = useSceneLayer('svg');
  const lineRef = useRef<SVGLineElement | null>(null);
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const lastScreenRef = useRef<{ x: number; y: number } | null>(null);

  const { ref: anchorRef } = useWorldAnchor<SVGGElement>(() => worldPoint, {
    onProject: (projection: AnchorProjection) => {
      // `isAnchorVisible` also rejects an off-canvas-but-truthy `screen`
      // (#5636 review) — a bare `projection.screen` read here would draw a
      // leader line anchored on a point that's really off-screen.
      lastScreenRef.current = isAnchorVisible(projection) ? projection.screen : null;
      applyLine();
    },
  });

  function applyLine() {
    const line = lineRef.current;
    const screen = lastScreenRef.current;
    if (!line) return;
    if (!screen) {
      line.style.display = 'none';
      return;
    }
    line.style.display = '';
    line.setAttribute('x1', String(screen.x));
    line.setAttribute('y1', String(screen.y));
    line.setAttribute('x2', String(screen.x + offsetRef.current.dx));
    line.setAttribute('y2', String(screen.y + offsetRef.current.dy));
  }

  useEffect(() => {
    // The anchor's own projection doesn't re-run just because `offset`
    // changed (only camera/anchor-registration dirt triggers a tick), so a
    // prop-driven offset move needs to re-apply against the last known
    // screen point immediately.
    applyLine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset.dx, offset.dy]);

  if (!svgLayer) return null;

  return createPortal(
    <>
      {/* Invisible anchor purely to keep the world point registered; the visible line is `lineRef`. */}
      <g ref={anchorRef} style={{ display: 'none' }} data-scene-primitive="leader-anchor" />
      <line
        ref={lineRef}
        style={{ display: 'none' }}
        data-scene-primitive="leader"
        className={cn('stroke-1', active ? 'stroke-overlay-accent' : 'stroke-overlay-ink-muted', className)}
        strokeDasharray={active ? undefined : '3 2'}
      />
    </>,
    svgLayer,
  );
}
