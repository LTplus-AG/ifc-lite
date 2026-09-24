/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `AxisArrow`: a directional arrow from a world-space foot to a world-space
 * tip, sized in screen px so it reads the same regardless of camera
 * distance — the pattern `SectionPlaneDragGizmo` hand-rolled per-frame
 * (#5486). Colour is a token: pass `axis-x`/`axis-y`/`axis-z` for a
 * navigation triad, or leave it accent/ink for a drag gizmo.
 *
 * Registers `foot` and `tip` as two independent projector anchors (both
 * land in the SAME tick — the projector processes every registered anchor
 * once per dirty tick, in registration order) and recomputes the line's
 * screen-space attributes from whichever pair of projections is freshest,
 * so it's correct regardless of which of the two callbacks fires last.
 */

import { createPortal } from 'react-dom';
import { useEffect, useId, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useSceneLayer } from '../SceneLayers';
import { useSceneProjector } from '../SceneProjectorProvider';
import { OVERLAY_ARROWHEAD_ACCENT_MARKER, OVERLAY_ARROWHEAD_INK_MARKER } from '../OverlayDefs';
import { isAnchorVisible, vec3Key } from '../projection';
import { useWakeOnChange } from '../useWakeOnChange';
import type { AnchorProjection, Vec3 } from '../types';

export type AxisArrowVariant = 'accent' | 'ink' | 'axis-x' | 'axis-y' | 'axis-z';

const VARIANT_STROKE_CLASS: Record<AxisArrowVariant, string> = {
  accent: 'stroke-overlay-accent',
  ink: 'stroke-overlay-ink',
  'axis-x': 'stroke-axis-x',
  'axis-y': 'stroke-axis-y',
  'axis-z': 'stroke-axis-z',
};

const MARKER: Record<AxisArrowVariant, string> = {
  accent: OVERLAY_ARROWHEAD_ACCENT_MARKER,
  ink: OVERLAY_ARROWHEAD_INK_MARKER,
  'axis-x': OVERLAY_ARROWHEAD_INK_MARKER,
  'axis-y': OVERLAY_ARROWHEAD_INK_MARKER,
  'axis-z': OVERLAY_ARROWHEAD_INK_MARKER,
};

export interface AxisArrowProps {
  /** World-space start of the arrow (the handle end). */
  foot: Vec3 | null;
  /** World-space point the arrow points toward — only its screen-projected DIRECTION from `foot` matters, not its distance. */
  tip: Vec3 | null;
  /** On-screen length of the arrow in CSS px, regardless of camera distance. Default 60 (matches the section drag gizmo). */
  lengthPx?: number;
  variant?: AxisArrowVariant;
  className?: string;
}

export function AxisArrow({ foot, tip, lengthPx = 60, variant = 'accent', className }: AxisArrowProps) {
  const svgLayer = useSceneLayer('svg');
  const projector = useSceneProjector();
  const lineRef = useRef<SVGLineElement | null>(null);
  const footProjection = useRef<AnchorProjection | null>(null);
  const tipProjection = useRef<AnchorProjection | null>(null);
  const baseId = useId();

  // Latest props/callback data without re-registering on every render.
  const latest = useRef({ foot, tip });
  latest.current = { foot, tip };

  useEffect(() => {
    if (!projector) return;
    const applyLine = () => {
      const line = lineRef.current;
      // `isAnchorVisible` also rejects an off-canvas-but-truthy `screen`
      // (#5636 review) — a bare `?.screen` read here would draw an arrow
      // anchored on a point that's really off-screen.
      const footScreen = isAnchorVisible(footProjection.current) ? footProjection.current!.screen : null;
      const tipScreen = isAnchorVisible(tipProjection.current) ? tipProjection.current!.screen : null;
      if (!line) return;
      if (!footScreen || !tipScreen) {
        line.style.display = 'none';
        return;
      }
      const dx = tipScreen.x - footScreen.x;
      const dy = tipScreen.y - footScreen.y;
      const len = Math.hypot(dx, dy) || 1;
      line.style.display = '';
      line.setAttribute('x1', String(footScreen.x));
      line.setAttribute('y1', String(footScreen.y));
      line.setAttribute('x2', String(footScreen.x + (dx / len) * lengthPx));
      line.setAttribute('y2', String(footScreen.y + (dy / len) * lengthPx));
    };
    const unregisterFoot = projector.registerAnchor(`${baseId}-foot`, () => latest.current.foot, (p) => {
      footProjection.current = p;
      applyLine();
    });
    const unregisterTip = projector.registerAnchor(`${baseId}-tip`, () => latest.current.tip, (p) => {
      tipProjection.current = p;
      applyLine();
    });
    return () => {
      unregisterFoot();
      unregisterTip();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projector, baseId, lengthPx]);

  // Registration (above) only wakes the projector once, at mount. With a
  // static camera, moving `foot` or `tip` by prop otherwise sits unread
  // until an unrelated wake (#5636 review, same class as `useWorldAnchor`'s
  // and `PlaneOutline`'s).
  useWakeOnChange(projector, `${vec3Key(foot)}|${vec3Key(tip)}`);

  if (!svgLayer) return null;

  return createPortal(
    <line
      ref={lineRef}
      style={{ display: 'none' }}
      data-scene-primitive="axis-arrow"
      className={cn(VARIANT_STROKE_CLASS[variant], 'stroke-2', className)}
      markerEnd={MARKER[variant]}
    />,
    svgLayer,
  );
}
