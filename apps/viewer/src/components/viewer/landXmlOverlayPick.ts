/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** CPU source pick for the exact LandXML line spans uploaded to the terrain channel. */

import type { ViewerState } from '@/store';
import type { LandXmlSourceRef } from '@/hooks/ingest/landXmlSemantics';
import { collectLandXmlOverlaySpans } from '@/hooks/ingest/landXmlOverlaySpans.js';

interface Projector {
  projectToScreen(point: { x: number; y: number; z: number }, width: number, height: number): { x: number; y: number } | null;
}

function distanceToSegment(x: number, y: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const denominator = dx * dx + dy * dy;
  const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / denominator));
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}

/**
 * Return a model-qualified source span only when the regular renderer pick
 * missed. This avoids claiming a line hidden behind a mesh is selectable.
 * The shared collector means selection filtering and frame rejection are
 * identical to the buffer that was actually sent to the renderer.
 */
export function pickLandXmlOverlayLine(
  state: ViewerState, projector: Projector, x: number, y: number, width: number, height: number,
): LandXmlSourceRef | null {
  let best: { distance: number; ref: LandXmlSourceRef } | null = null;
  for (const span of collectLandXmlOverlaySpans(state)) {
    const a = projector.projectToScreen(span.a, width, height);
    const b = projector.projectToScreen(span.b, width, height);
    if (!a || !b) continue;
    const distance = distanceToSegment(x, y, a, b);
    if (distance <= 8 && (best === null || distance < best.distance)) best = { distance, ref: span.ref };
  }
  return best?.ref ?? null;
}
