/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Visual overlay for the GPU rectangle-select drag (Ctrl/⌘ + LMB
 * over the canvas in select mode). Renders an SVG outline whenever
 * `rect` is non-null; the parent supplies / clears the prop in step
 * with the mouse handler.
 *
 * Drawn in the one selection accent (`overlay-accent`, #5491), the same token
 * the renderer tints selected meshes with, so the marquee and what it selects
 * read as one colour in every theme.
 */

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
  if (!rect) return null;
  const left = Math.min(rect.x0, rect.x1);
  const top = Math.min(rect.y0, rect.y1);
  const width = Math.abs(rect.x1 - rect.x0);
  const height = Math.abs(rect.y1 - rect.y0);
  if (width < 1 || height < 1) return null;
  return (
    <svg
      className="absolute inset-0 pointer-events-none"
      style={{ width: '100%', height: '100%' }}
      aria-hidden="true"
    >
      <rect
        x={left}
        y={top}
        width={width}
        height={height}
        className="fill-overlay-accent-soft stroke-overlay-accent"
        strokeWidth={1}
        strokeDasharray="4 3"
      />
    </svg>
  );
}
