/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** CPU source pick for the exact LandXML line spans uploaded to the terrain channel. */

import { totalYupOffset } from '@ifc-lite/geometry/world-frame';
import type { ViewerState } from '@/store';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state';
import { modelPointToWorkspacePoint } from '@/lib/model-placement/rotation';
import { fromRenderTranslation, toRenderTranslation } from '@/lib/model-placement/translation';
import type { LandXmlSourceRef } from '@/hooks/ingest/landXmlSemantics';

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
 * Curves and transitions are intentionally absent: they have no overlay span
 * until a certified native sampling path is added.
 */
export function pickLandXmlOverlayLine(
  state: ViewerState, projector: Projector, x: number, y: number, width: number, height: number,
): LandXmlSourceRef | null {
  let best: { distance: number; ref: LandXmlSourceRef } | null = null;
  for (const model of state.models.values()) {
    const document = model.landXmlDocument, frame = model.geometryResult?.coordinateInfo;
    if (!model.visible || !document?.units || !frame) continue;
    const offset = totalYupOffset(frame);
    const placement = { ...placementFor(state.modelPlacement, model.id), translation: displayedTranslation(state.modelPlacement, model.id) };
    const screen = (northing: number, easting: number): { x: number; y: number } | null => {
      const local = { x: easting * document.units!.linearScaleToMeters - offset.x, y: -offset.y, z: -northing * document.units!.linearScaleToMeters - offset.z };
      if (!Object.values(local).every(Number.isFinite)) return null;
      const [px, py, pz] = toRenderTranslation(modelPointToWorkspacePoint(fromRenderTranslation(local), placement));
      return projector.projectToScreen({ x: px, y: py, z: pz }, width, height);
    };
    for (const alignment of document.alignments ?? []) {
      for (const segment of alignment.segments) {
        const primitive = segment.primitive;
        if ((primitive.kind !== 'line' && primitive.kind !== 'irregular_line') || primitive.start.kind !== 'coordinates' || primitive.end.kind !== 'coordinates') continue;
        const points = primitive.kind === 'line' ? [primitive.start.point, primitive.end.point] : [primitive.start.point, ...primitive.points, primitive.end.point];
        for (let index = 1; index < points.length; index++) {
          const a = screen(points[index - 1].northing, points[index - 1].easting), b = screen(points[index].northing, points[index].easting);
          if (!a || !b) continue;
          const distance = distanceToSegment(x, y, a, b);
          if (distance <= 8 && (best === null || distance < best.distance)) best = { distance, ref: { modelId: model.id, sourceId: segment.sourceId } };
        }
      }
    }
  }
  return best?.ref ?? null;
}
