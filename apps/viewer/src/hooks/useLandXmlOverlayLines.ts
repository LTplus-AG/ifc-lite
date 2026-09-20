/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, type RefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { totalYupOffset } from '@ifc-lite/geometry/world-frame';
import { useViewerStore } from '../store/index.js';
import { boundsFitRenderFrame } from './ingest/landXmlRenderFrame.js';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state';
import { modelPointToWorkspacePoint } from '@/lib/model-placement/rotation';
import { fromRenderTranslation, toRenderTranslation } from '@/lib/model-placement/translation';
import { runGpuUpload } from '@/components/viewer/gpu-upload-guard';
import type { LandXmlPlanGeometry, LandXmlPlanPoint, LandXmlTinDocument } from './ingest/landXmlSemantics.js';

export interface LandXmlOverlayUploadTarget {
  setLineOverlay(channel: 'terrain', vertices: Float32Array | null): void;
}

/** Contain a terrain-line GPU upload and discard a partial buffer on failure. */
export function uploadLandXmlOverlayGuarded(
  renderer: LandXmlOverlayUploadTarget,
  vertices: Float32Array,
): void {
  if (vertices.length === 0) {
    renderer.setLineOverlay('terrain', null);
    return;
  }
  const uploaded = runGpuUpload('setLineOverlay:terrain', () => {
    renderer.setLineOverlay('terrain', vertices);
    return true;
  });
  if (!uploaded) renderer.setLineOverlay('terrain', null);
}

/**
 * LandXML 1.2 `Contour` permits a two-dimensional point list when its `elev`
 * attribute supplies the missing ordinate.  Boundaries and breaklines have no
 * equivalent schema field, so only contours may be lifted this way.
 */
export function contourElevation(line: { coordinateDimension: 2 | 3; properties: Record<string, string> }): number | null {
  if (line.coordinateDimension !== 2) return null;
  const authored = line.properties.elev;
  if (authored === undefined || authored.trim() === '') return null;
  const elevation = Number(authored);
  return Number.isFinite(elevation) ? elevation : null;
}

function planGeometryBySource(document: LandXmlTinDocument): Map<string, LandXmlPlanGeometry> {
  const geometry = new Map<string, LandXmlPlanGeometry>();
  const plan = document.plan;
  if (!plan) return geometry;
  for (const feature of plan.planFeatures) for (const item of feature.geometry) geometry.set(item.sourceId, item);
  for (const parcel of plan.parcels) for (const loop of parcel.loops) for (const item of loop) geometry.set(item.sourceId, item);
  return geometry;
}

function planPolyline(
  geometry: LandXmlPlanGeometry,
  resolved: { start: LandXmlPlanPoint | null; end: LandXmlPlanPoint | null },
): LandXmlPlanPoint[] | null {
  if (!resolved.start || !resolved.end || geometry.kind === 'curve') return null;
  return [resolved.start, ...(geometry.kind === 'irregular_line' ? geometry.intermediatePoints : []), resolved.end];
}

/**
 * Adapt authored 3D LandXML boundary/breakline/contour coordinates into the
 * currently published model frame. A two-dimensional Contour with its
 * schema-defined `elev` attribute is lifted using that authored elevation;
 * other two-dimensional lists remain inspectable without invented geometry.
 */
export function useLandXmlOverlayLines(): Float32Array {
  const models = useViewerStore((state) => state.models);
  const selectedSource = useViewerStore((state) => state.selectedLandXmlSource);
  const placement = useViewerStore((state) => state.modelPlacement);
  return useMemo(() => {
    const vertices: number[] = [];
    for (const model of models.values()) {
      if (!model.visible) continue;
      const document = model.landXmlDocument;
      const frame = model.geometryResult?.coordinateInfo;
      const units = document?.units;
      if (!document || !frame || !units) continue;
      const offset = totalYupOffset(frame);
      const modelPlacement = placementFor(placement, model.id);
      const pointPlacement = { ...modelPlacement, translation: displayedTranslation(placement, model.id) };
      const place = (point: { x: number; y: number; z: number }) => toRenderTranslation(
        modelPointToWorkspacePoint(fromRenderTranslation(point), pointPlacement),
      );
      for (const surface of document.surfaces) {
        for (const [lineKind, line] of [
          ...surface.boundaries.map((line) => ['boundary', line] as const),
          ...surface.breaklines.map((line) => ['breakline', line] as const),
          ...surface.contours.map((line) => ['contour', line] as const),
        ]) {
          // A source-list selection is deliberately a filter, not an IFC pick:
          // line GPU picking has no model/source identity channel. This keeps
          // the selected non-IFC record and its visible geometry in lockstep.
          if (selectedSource && (selectedSource.modelId !== model.id || selectedSource.sourceId !== line.sourceId)) {
            continue;
          }
          const planarContourElevation = lineKind === 'contour' ? contourElevation(line) : null;
          if (line.coordinateDimension !== 3 && planarContourElevation === null) continue;
          for (let index = 1; index < line.points.length; index++) {
            const [northA, eastA, pointElevationA] = line.points[index - 1];
            const [northB, eastB, pointElevationB] = line.points[index];
            const elevationA = pointElevationA ?? planarContourElevation;
            const elevationB = pointElevationB ?? planarContourElevation;
            if (elevationA === null || elevationB === null) continue;
            const localA = {
              x: eastA * units.linearScaleToMeters - offset.x,
              y: elevationA * units.elevationScaleToMeters - offset.y,
              z: -northA * units.linearScaleToMeters - offset.z,
            };
            const localB = {
              x: eastB * units.linearScaleToMeters - offset.x,
              y: elevationB * units.elevationScaleToMeters - offset.y,
              z: -northB * units.linearScaleToMeters - offset.z,
            };
            if (![localA.x, localA.y, localA.z, localB.x, localB.y, localB.z].every(Number.isFinite)) continue;
            if (!boundsFitRenderFrame({
              min: { x: Math.min(localA.x, localB.x), y: Math.min(localA.y, localB.y), z: Math.min(localA.z, localB.z) },
              max: { x: Math.max(localA.x, localB.x), y: Math.max(localA.y, localB.y), z: Math.max(localA.z, localB.z) },
            }, { x: 0, y: 0, z: 0 })) continue;
            const [ax, ay, az] = place(localA);
            const [bx, by, bz] = place(localB);
            const a = { x: ax, y: ay, z: az };
            const b = { x: bx, y: by, z: bz };
            if (!boundsFitRenderFrame({
              min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
              max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
            }, { x: 0, y: 0, z: 0 })) continue;
            vertices.push(a.x, a.y, a.z, b.x, b.y, b.z);
          }
        }
      }
      const plan = document.plan;
      if (!plan) continue;
      const geometryBySource = planGeometryBySource(document);
      const resolvedBySource = new Map(plan.resolvedGeometry.map((geometry) => [geometry.sourceId, geometry]));
      // Rust partitions records into bounded source batches. The renderer
      // consumes every batch into this one line buffer: large COGO plans do
      // not create a GPU resource for every source primitive.
      for (const batch of plan.sourceBatches) for (const sourceId of batch.sourceIds) {
        const geometry = geometryBySource.get(sourceId);
        const resolved = resolvedBySource.get(sourceId);
        if (!geometry || !resolved || (selectedSource && (selectedSource.modelId !== model.id || selectedSource.sourceId !== sourceId))) continue;
        const points = planPolyline(geometry, resolved);
        if (!points) continue;
        for (let index = 1; index < points.length; index++) {
          const previous = points[index - 1];
          const next = points[index];
          const localA = { x: previous.easting * units.linearScaleToMeters - offset.x, y: (previous.elevation ?? 0) * units.elevationScaleToMeters - offset.y, z: -previous.northing * units.linearScaleToMeters - offset.z };
          const localB = { x: next.easting * units.linearScaleToMeters - offset.x, y: (next.elevation ?? 0) * units.elevationScaleToMeters - offset.y, z: -next.northing * units.linearScaleToMeters - offset.z };
          if (![localA.x, localA.y, localA.z, localB.x, localB.y, localB.z].every(Number.isFinite)) continue;
          const [ax, ay, az] = place(localA);
          const [bx, by, bz] = place(localB);
          if (![ax, ay, az, bx, by, bz].every(Number.isFinite)) continue;
          vertices.push(ax, ay, az, bx, by, bz);
        }
      }
    }
    return new Float32Array(vertices);
  }, [models, selectedSource, placement]);
}

/** Keep the renderer's terrain channel synchronized with authored LandXML lines. */
export function useLandXmlRendererOverlay(
  rendererRef: RefObject<Renderer | null>,
  isInitialized: boolean,
): void {
  const vertices = useLandXmlOverlayLines();
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;
    uploadLandXmlOverlayGuarded(renderer, vertices);
  }, [vertices, isInitialized, rendererRef]);
}
