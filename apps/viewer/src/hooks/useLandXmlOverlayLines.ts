/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, type RefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '../store/index.js';
import { collectLandXmlOverlaySpans, overlaySpanVertices } from './ingest/landXmlOverlaySpans.js';
import { runGpuUpload } from '@/components/viewer/gpu-upload-guard';
import type { LandXmlPlanGeometry, LandXmlPlanPoint, LandXmlTinDocument } from './ingest/landXmlSemantics.js';
import { totalYupOffset } from '@ifc-lite/geometry/world-frame';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state';
import { modelPointToWorkspacePoint } from '@/lib/model-placement/rotation';
import { fromRenderTranslation, toRenderTranslation } from '@/lib/model-placement/translation';
import { planPolyline } from './ingest/landXmlPlanGeometry.js';
import { boundsFitRenderFrame } from './ingest/landXmlRenderFrame.js';

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
function planGeometryBySource(document: LandXmlTinDocument): Map<string, LandXmlPlanGeometry> {
  const geometry = new Map<string, LandXmlPlanGeometry>();
  const plan = document.plan;
  if (!plan) return geometry;
  for (const feature of plan.planFeatures) for (const item of feature.geometry) geometry.set(item.sourceId, item);
  for (const parcel of plan.parcels) for (const loop of parcel.loops) for (const item of loop) geometry.set(item.sourceId, item);
  return geometry;
}

function planGeometryOwners(document: LandXmlTinDocument): Map<string, string> {
  const owners = new Map<string, string>();
  const plan = document.plan;
  if (!plan) return owners;
  for (const feature of plan.planFeatures) for (const geometry of feature.geometry) owners.set(geometry.sourceId, feature.sourceId);
  for (const parcel of plan.parcels) for (const loop of parcel.loops) for (const geometry of loop) owners.set(geometry.sourceId, parcel.sourceId);
  return owners;
}

function boundsForSegment(left: { x: number; y: number; z: number }, right: { x: number; y: number; z: number }) {
  return {
    min: { x: Math.min(left.x, right.x), y: Math.min(left.y, right.y), z: Math.min(left.z, right.z) },
    max: { x: Math.max(left.x, right.x), y: Math.max(left.y, right.y), z: Math.max(left.z, right.z) },
  };
}

/** Reject unsafe coordinates before and after user placement, before f32 upload. */
function appendPlacedSegment(
  vertices: number[],
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
  place: (point: { x: number; y: number; z: number }) => readonly [number, number, number],
): void {
  if (![left.x, left.y, left.z, right.x, right.y, right.z].every(Number.isFinite)
    || !boundsFitRenderFrame(boundsForSegment(left, right), { x: 0, y: 0, z: 0 })) return;
  const [ax, ay, az] = place(left);
  const [bx, by, bz] = place(right);
  const placedLeft = { x: ax, y: ay, z: az };
  const placedRight = { x: bx, y: by, z: bz };
  if (![ax, ay, az, bx, by, bz].every(Number.isFinite)
    || !boundsFitRenderFrame(boundsForSegment(placedLeft, placedRight), { x: 0, y: 0, z: 0 })) return;
  vertices.push(ax, ay, az, bx, by, bz);
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
    const vertices = [...overlaySpanVertices(collectLandXmlOverlaySpans({
      models, selectedLandXmlSource: selectedSource, modelPlacement: placement,
    }))];
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
      const plan = document.plan;
      if (!plan) continue;
      const geometryBySource = planGeometryBySource(document);
      const ownerByGeometry = planGeometryOwners(document);
      const resolvedBySource = new Map(plan.resolvedGeometry.map((geometry) => [geometry.sourceId, geometry]));
      const cogoBySource = new Map(plan.cogoPoints.map((point) => [point.sourceId, point.point]));
      const monumentBySource = new Map(plan.resolvedMonuments.map((monument) => [monument.sourceId, monument.point]));
      const localPoint = (point: LandXmlPlanPoint) => point.renderedPointState === 'suppressed' ? null : (
        point.renderedPoint
          ? { x: point.renderedPoint[0], y: point.renderedPoint[1], z: point.renderedPoint[2] }
          : {
              x: point.easting * units.linearScaleToMeters - offset.x,
              y: (point.elevation ?? 0) * units.elevationScaleToMeters - offset.y,
              z: -point.northing * units.linearScaleToMeters - offset.z,
            }
      );
      const appendMarker = (point: LandXmlPlanPoint) => {
        const local = localPoint(point);
        if (!local) return;
        const halfSize = 0.25;
        appendPlacedSegment(vertices, { ...local, x: local.x - halfSize }, { ...local, x: local.x + halfSize }, place);
        appendPlacedSegment(vertices, { ...local, z: local.z - halfSize }, { ...local, z: local.z + halfSize }, place);
      };
      // Rust partitions records into bounded source batches. The renderer
      // consumes every batch into this one line buffer: large COGO plans do
      // not create a GPU resource for every source primitive.
      for (const batch of plan.sourceBatches) for (const sourceId of batch.sourceIds) {
        const geometry = geometryBySource.get(sourceId);
        const resolved = resolvedBySource.get(sourceId);
        if (selectedSource && (selectedSource.modelId !== model.id
          || (selectedSource.sourceId !== sourceId && selectedSource.sourceId !== ownerByGeometry.get(sourceId)))) continue;
        const marker = cogoBySource.get(sourceId) ?? monumentBySource.get(sourceId);
        if (marker) {
          appendMarker(marker);
          continue;
        }
        if (!geometry || !resolved) continue;
        if (resolved.renderedPointState === 'suppressed') continue;
        const points = resolved.renderedPoints ?? planPolyline(geometry, resolved);
        if (!points) continue;
        for (let index = 1; index < points.length; index++) {
          const previous = points[index - 1];
          const next = points[index];
          const localPrevious = Array.isArray(previous)
            ? { x: previous[0], y: previous[1], z: previous[2] }
            : localPoint(previous);
          const localNext = Array.isArray(next)
            ? { x: next[0], y: next[1], z: next[2] }
            : localPoint(next);
          if (localPrevious && localNext) appendPlacedSegment(vertices, localPrevious, localNext, place);
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
