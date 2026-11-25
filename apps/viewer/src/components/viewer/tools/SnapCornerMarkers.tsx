/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Snap markers (#11504): the feature corners near the cursor that the
 * CAD-style corner search offers, with the one the pick will use highlighted.
 * Drawn while a snapping tool picks points (Measure, a modeling command, a
 * Reposition pick) with snapping on.
 *
 * The corner list is the renderer's own (`Renderer.cornerMarkers`, published
 * after each magnetic pick), so a marker is never shown that the snap would
 * refuse. The highlighted marker is the existing snap glyph (`SnapGlyphShape`,
 * accent with halo and glow); the others are small outlines in the overlay ink
 * tokens. Nothing animates, so there is no motion to reduce, and nothing is
 * drawn once the camera has moved off the view the corners were projected under.
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { ScreenCornerMarkers } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/lib/renderer-ref';
import { cornerMarkerViews, isSnapPicking } from '@/lib/snap/corner-assist';
import { SnapGlyphShape, useProjectorTick } from '../../viewport-ui/scene';

const HALF = 3;

export function SnapCornerMarkers(): ReactNode {
  const picking = useViewerStore((s) => isSnapPicking(s) && s.snapEnabled);
  const [markers, setMarkers] = useState<ScreenCornerMarkers | null>(null);
  useEffect(() => {
    const renderer = picking ? getGlobalRenderer() : null;
    if (!renderer) { setMarkers(null); return; }
    const channel = renderer.cornerMarkers;
    setMarkers(channel.get());
    return channel.subscribe(() => setMarkers(channel.get()));
  }, [picking]);
  // Re-render when the camera moves, so markers projected under an old view go away at once.
  void useProjectorTick(picking && markers !== null);
  if (!picking || !markers) return null;
  const views = cornerMarkerViews(markers, getGlobalRenderer()?.readbackRaycastViewKey() ?? null);
  if (views.length === 0) return null;
  return (
    <svg className="absolute inset-0 pointer-events-none z-(--z-scene)" style={{ overflow: 'visible' }} aria-hidden="true" data-snap-corner-markers="">
      {views.map((v) => (
        <g key={v.key} transform={`translate(${v.x} ${v.y})`} data-snap-corner-marker={v.active ? 'active' : 'candidate'}>
          {v.active ? <SnapGlyphShape kind="endpoint" /> : (
            <rect x={-HALF} y={-HALF} width={2 * HALF} height={2 * HALF} className="fill-none stroke-overlay-ink-muted" strokeWidth={1.5} />
          )}
        </g>
      ))}
    </svg>
  );
}
