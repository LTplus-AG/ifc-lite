/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Finished 2D drawing markup measurements (#6833): `measure2DResults`
 * (distances) and `polygonArea2DResults` (areas) from `drawing2DSlice`.
 *
 * Units: drawing coordinates are world metres projected onto the section
 * plane without scaling (`projectTo2D` / `projectTo2DBasis` in
 * `@ifc-lite/drawing-2d` only drop the cut axis), and the panel labels the
 * stored values with `formatDistance(metres)` / `formatArea(m²)`. The print
 * scale only applies at export, never to these values.
 *
 * Provenance: the results are flat, federation-wide store fields scoped to
 * the active model by `drawing2DSlice.markupTransition.ts`; they are not
 * tagged with the section they were drawn on and survive a regeneration
 * (`clearDrawing2D` leaves markup alone), so the per-row section is unknown.
 */

import type { ViewerState } from '@/store';
import { evidenceRow, unavailableCapture, type EvidenceAdapter } from './types';

const LIMITATIONS = 'Distances and areas are user-drawn markup on the 2D drawing, measured in drawing coordinates (world metres projected onto the section plane, unscaled). '
  + 'Rows are not tagged with the section they were drawn on: markup survives regenerating or moving the cut, so currentDrawing describes the drawing on screen now, not necessarily the one each row was drawn on. '
  + 'Values are measured between picked points (snapped or free), not element quantities. Distances and areas are different units and are never summed together. '
  + 'Text and revision-cloud annotations are counted only; their content is not included.';

const round = (value: number): number => Math.round(value * 1e4) / 1e4;

function populationOf(s: ViewerState): number {
  return s.measure2DResults.length + s.polygonArea2DResults.length;
}

function* drawingRows(s: ViewerState) {
  for (const m of s.measure2DResults) {
    yield evidenceRow({ kind: 'distance', unit: 'm' }, { id: m.id, value: m.distance,
      start: { x: round(m.start.x), y: round(m.start.y) }, end: { x: round(m.end.x), y: round(m.end.y) } });
  }
  for (const a of s.polygonArea2DResults) {
    yield evidenceRow({ kind: 'area', unit: 'm2' }, { id: a.id, value: a.area,
      perimeter: a.perimeter, perimeterUnit: 'm', vertexCount: a.points.length });
  }
}

function currentDrawing(s: ViewerState) {
  const drawing = s.drawing2D;
  if (!drawing) return { status: s.drawing2DStatus, plane: null };
  const plane = drawing.config.plane;
  return { status: s.drawing2DStatus,
    plane: { axis: plane.axis, position: plane.position, flipped: plane.flipped, customPlane: plane.customPlane !== undefined } };
}

export const drawingMeasurementsAdapter: EvidenceAdapter = {
  id: 'drawingMeasurements', group: 'quantities', panelIds: ['drawing'],
  titleKey: 'assistantSources.drawingMeasurements.title', descriptionKey: 'assistantSources.drawingMeasurements.description',
  rowMeaningKey: 'assistantSources.drawingMeasurements.rows', unavailableKey: 'assistantSources.drawingMeasurements.unavailable',
  suggestionKeys: ['assistantSources.drawingMeasurements.suggestExplain'],
  readiness: s => {
    const count = populationOf(s);
    return count > 0
      ? { status: { labelKey: 'assistantSources.drawingMeasurements.ready', params: { count } }, ready: true }
      : { status: { labelKey: 'assistantSources.drawingMeasurements.none' }, ready: false };
  },
  identity: s => [s.measure2DResults, s.polygonArea2DResults, s.drawing2D],
  capture: (s, limit) => {
    const total = populationOf(s);
    if (total === 0) return unavailableCapture({ kind: 'drawing-measurements', measurementCount: 0 });
    const rows: unknown[] = [];
    for (const row of drawingRows(s)) {
      if (rows.length >= limit) break;
      rows.push(row);
    }
    return {
      summary: {
        kind: 'drawing-measurements', measurementCount: total,
        byKind: {
          distance: { count: s.measure2DResults.length, unit: 'm' },
          area: { count: s.polygonArea2DResults.length, unit: 'm2', perimeterUnit: 'm' },
        },
        markupModelId: s.activeModelId,
        currentDrawing: currentDrawing(s),
        otherMarkup: { textAnnotations: s.textAnnotations2D.length, revisionClouds: s.cloudAnnotations2D.length },
        limitations: LIMITATIONS,
      },
      rows, totalRows: total, availability: 'available',
    };
  },
};
