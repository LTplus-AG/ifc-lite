/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Visual overlay for the GPU rectangle-select drag (Ctrl/⌘ + LMB
 * over the canvas in select mode). Renders an SVG outline whenever
 * `rect` is non-null; the parent supplies / clears the prop in step
 * with the mouse handler.
 *
 * On the shared scene-overlay kernel (#5486/#5512, charter #5478): the
 * rect is already screen-space CSS px (the mouse handler reports it
 * directly, nothing to project), so this portals straight into the
 * kernel's SVG layer via `useSceneLayer` instead of mounting its own
 * `<svg>` element with its own stacking context.
 */

import { createPortal } from 'react-dom';
import { useSceneLayer } from '@/components/viewport-ui/scene';

export interface RectSelectionRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface RectSelectionOverlayProps {
  rect: RectSelectionRect | null;
}

export function RectSelectionOverlay({ rect }: RectSelectionOverlayProps) {
  const svgLayer = useSceneLayer('svg');
  if (!svgLayer || !rect) return null;
  const left = Math.min(rect.x0, rect.x1);
  const top = Math.min(rect.y0, rect.y1);
  const width = Math.abs(rect.x1 - rect.x0);
  const height = Math.abs(rect.y1 - rect.y0);
  if (width < 1 || height < 1) return null;
  return createPortal(
    <rect
      data-scene-primitive="rect-selection"
      x={left}
      y={top}
      width={width}
      height={height}
      className="fill-overlay-accent-soft stroke-overlay-accent"
      strokeWidth={1}
      strokeDasharray="4 3"
    />,
    svgLayer,
  );
}
