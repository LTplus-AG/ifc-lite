/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Exact source spans admitted to the LandXML terrain overlay and CPU picker. */

import { totalYupOffset } from '@ifc-lite/geometry/world-frame';
import type { ViewerState } from '@/store';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state';
import { modelPointToWorkspacePoint } from '@/lib/model-placement/rotation';
import { fromRenderTranslation, toRenderTranslation } from '@/lib/model-placement/translation';
import { boundsFitRenderFrame } from './landXmlRenderFrame.js';
import type { LandXmlSourceRef } from './landXmlSemantics.js';

export interface LandXmlOverlaySpan { ref: LandXmlSourceRef; a: { x: number; y: number; z: number }; b: { x: number; y: number; z: number } }

export function contourElevation(line: { coordinateDimension: 2 | 3; properties: Record<string, string> }): number | null {
  if (line.coordinateDimension !== 2) return null;
  const authored = line.properties.elev;
  if (authored === undefined || authored.trim() === '') return null;
  const elevation = Number(authored);
  return Number.isFinite(elevation) ? elevation : null;
}

/**
 * This is the sole admission path for both upload and CPU picking. Its span
 * list already includes visibility, source selection, frame checks and every
 * coordinate conversion, so a non-emitted (including hidden) span cannot win.
 */
export function collectLandXmlOverlaySpans(state: Pick<ViewerState, 'models' | 'selectedLandXmlSource' | 'modelPlacement'>): LandXmlOverlaySpan[] {
  const spans: LandXmlOverlaySpan[] = [];
  for (const model of state.models.values()) {
    if (!model.visible) continue;
    const document = model.landXmlDocument;
    const frame = model.geometryResult?.coordinateInfo;
    const units = document?.units;
    if (!document || !frame || !units) continue;
    const selected = state.selectedLandXmlSource;
    const offset = totalYupOffset(frame);
    const placement = { ...placementFor(state.modelPlacement, model.id), translation: displayedTranslation(state.modelPlacement, model.id) };
    const place = (point: { x: number; y: number; z: number }) => {
      const [x, y, z] = toRenderTranslation(modelPointToWorkspacePoint(fromRenderTranslation(point), placement));
      return { x, y, z };
    };
    const append = (ref: LandXmlSourceRef, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): void => {
      if (!Object.values(a).concat(Object.values(b)).every(Number.isFinite)) return;
      if (!boundsFitRenderFrame({ min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) }, max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) } }, { x: 0, y: 0, z: 0 })) return;
      const renderedA = place(a), renderedB = place(b);
      if (!boundsFitRenderFrame({ min: { x: Math.min(renderedA.x, renderedB.x), y: Math.min(renderedA.y, renderedB.y), z: Math.min(renderedA.z, renderedB.z) }, max: { x: Math.max(renderedA.x, renderedB.x), y: Math.max(renderedA.y, renderedB.y), z: Math.max(renderedA.z, renderedB.z) } }, { x: 0, y: 0, z: 0 })) return;
      spans.push({ ref, a: renderedA, b: renderedB });
    };
    for (const surface of document.surfaces) for (const [kind, line] of [
      ...surface.boundaries.map((line) => ['boundary', line] as const), ...surface.breaklines.map((line) => ['breakline', line] as const), ...surface.contours.map((line) => ['contour', line] as const),
    ]) {
      if (selected && (selected.modelId !== model.id || selected.sourceId !== line.sourceId)) continue;
      const elevation = kind === 'contour' ? contourElevation(line) : null;
      if (line.coordinateDimension !== 3 && elevation === null) continue;
      for (let index = 1; index < line.points.length; index++) {
        const [northA, eastA, elevationA] = line.points[index - 1]; const [northB, eastB, elevationB] = line.points[index];
        const aElevation = elevationA ?? elevation, bElevation = elevationB ?? elevation;
        if (aElevation === null || bElevation === null) continue;
        append({ modelId: model.id, sourceId: line.sourceId }, { x: eastA * units.linearScaleToMeters - offset.x, y: aElevation * units.elevationScaleToMeters - offset.y, z: -northA * units.linearScaleToMeters - offset.z }, { x: eastB * units.linearScaleToMeters - offset.x, y: bElevation * units.elevationScaleToMeters - offset.y, z: -northB * units.linearScaleToMeters - offset.z });
      }
    }
    for (const alignment of document.alignments ?? []) {
      if (selected && (selected.modelId !== model.id || (selected.sourceId !== alignment.sourceId && !alignment.segments.some((segment) => segment.sourceId === selected.sourceId)))) continue;
      for (const segment of alignment.segments) {
        if (selected && selected.sourceId !== alignment.sourceId && selected.sourceId !== segment.sourceId) continue;
        const primitive = segment.primitive;
        if ((primitive.kind !== 'line' && primitive.kind !== 'irregular_line') || primitive.start.kind !== 'coordinates' || primitive.end.kind !== 'coordinates') continue;
        const points = primitive.kind === 'irregular_line' ? [primitive.start.point, ...primitive.points, primitive.end.point] : [primitive.start.point, primitive.end.point];
        for (let index = 1; index < points.length; index++) append({ modelId: model.id, sourceId: segment.sourceId }, { x: points[index - 1].easting * units.linearScaleToMeters - offset.x, y: -offset.y, z: -points[index - 1].northing * units.linearScaleToMeters - offset.z }, { x: points[index].easting * units.linearScaleToMeters - offset.x, y: -offset.y, z: -points[index].northing * units.linearScaleToMeters - offset.z });
      }
    }
  }
  return spans;
}

export function overlaySpanVertices(spans: readonly LandXmlOverlaySpan[]): Float32Array {
  return new Float32Array(spans.flatMap((span) => [span.a.x, span.a.y, span.a.z, span.b.x, span.b.y, span.b.z]));
}
