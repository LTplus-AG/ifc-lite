/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Rebuild immutable LandXML line records into a federated render frame. */

import { localViewerToProjected, projectedToLocalViewer, type CoordinateInfo, type ModelSpatialReference } from '@ifc-lite/geometry';
import proj4 from 'proj4';
import { totalYupOffset } from '../../lib/geo/coordinate-frame.js';
import { resolveProjectionId } from '../../lib/geo/reproject.js';
import { projectedUnitToMetres } from './projected-units.js';
import { planPolyline } from './landXmlPlanGeometry.js';
import type {
  LandXmlAlignmentSegment, LandXmlPlanGeometry, LandXmlPlanPoint, LandXmlPolyline, LandXmlResolvedGeometry,
  LandXmlTinDocument,
} from './landXmlSemantics.js';

interface LandXmlRenderedPolylineUpdate {
  kind: 'line';
  line: LandXmlPolyline;
  renderedPoints?: number[][];
  renderedPointState?: 'aligned' | 'suppressed';
}

interface LandXmlRenderedPlanPointUpdate {
  kind: 'plan-point';
  point: LandXmlPlanPoint;
  renderedPoint?: [number, number, number];
  renderedPointState?: 'aligned' | 'suppressed';
}

interface LandXmlRenderedPlanGeometryUpdate {
  kind: 'plan-geometry';
  geometry: LandXmlResolvedGeometry;
  renderedPoints?: [number, number, number][];
  renderedPointState?: 'aligned' | 'suppressed';
}

interface LandXmlRenderedAlignmentUpdate {
  kind: 'alignment-segment';
  segment: LandXmlAlignmentSegment;
  renderedPoints?: [number, number, number][];
  renderedPointState?: 'aligned' | 'suppressed';
}

export type LandXmlRenderedLineUpdate = LandXmlRenderedPolylineUpdate
  | LandXmlRenderedPlanPointUpdate | LandXmlRenderedPlanGeometryUpdate
  | LandXmlRenderedAlignmentUpdate;

function lines(document: LandXmlTinDocument): LandXmlPolyline[] {
  return document.surfaces.flatMap((surface) => [
    ...surface.boundaries, ...surface.breaklines, ...surface.contours,
  ]);
}

function planGeometryBySource(document: LandXmlTinDocument): Map<string, LandXmlPlanGeometry> {
  const result = new Map<string, LandXmlPlanGeometry>();
  for (const feature of document.plan?.planFeatures ?? []) {
    for (const geometry of feature.geometry) result.set(geometry.sourceId, geometry);
  }
  for (const parcel of document.plan?.parcels ?? []) {
    for (const loop of parcel.loops) for (const geometry of loop) result.set(geometry.sourceId, geometry);
  }
  return result;
}

function planPoints(document: LandXmlTinDocument): LandXmlPlanPoint[] {
  const unique = new Set<LandXmlPlanPoint>();
  for (const point of document.plan?.cogoPoints ?? []) if (point.point) unique.add(point.point);
  for (const monument of document.plan?.resolvedMonuments ?? []) if (monument.point) unique.add(monument.point);
  return [...unique];
}

function alignmentSegmentPoints(segment: LandXmlAlignmentSegment): LandXmlPlanPoint[] | null {
  const primitive = segment.primitive;
  if (primitive.kind === 'unsupported_spiral'
    || primitive.start.kind !== 'coordinates' || primitive.end.kind !== 'coordinates') return null;
  if (primitive.kind === 'irregular_line') return [primitive.start.point, ...primitive.points, primitive.end.point];
  if (primitive.kind === 'line') return [primitive.start.point, primitive.end.point];
  return segment.renderPoints ?? null;
}

/** Clear derived points when a source is no longer aligned to an anchor. */
export function clearLandXmlRenderedLineUpdates(document: LandXmlTinDocument): LandXmlRenderedLineUpdate[] {
  return [
    ...lines(document).map((line): LandXmlRenderedLineUpdate => ({ kind: 'line', line })),
    ...document.alignments.flatMap((alignment) => alignment.segments.map(
      (segment): LandXmlRenderedLineUpdate => ({ kind: 'alignment-segment', segment }),
    )),
    ...planPoints(document).map((point): LandXmlRenderedLineUpdate => ({ kind: 'plan-point', point })),
    ...(document.plan?.resolvedGeometry ?? []).map((geometry): LandXmlRenderedLineUpdate => ({
      kind: 'plan-geometry', geometry,
    })),
  ];
}

/** Apply a prepared result only after its whole rebuild has succeeded. */
export function applyLandXmlRenderedLineUpdates(updates: readonly LandXmlRenderedLineUpdate[]): void {
  for (const update of updates) {
    if (update.kind === 'plan-point') {
      if (update.renderedPoint) update.point.renderedPoint = update.renderedPoint;
      else delete update.point.renderedPoint;
      if (update.renderedPointState) update.point.renderedPointState = update.renderedPointState;
      else delete update.point.renderedPointState;
      continue;
    }
    if (update.kind === 'plan-geometry') {
      if (update.renderedPoints) update.geometry.renderedPoints = update.renderedPoints;
      else delete update.geometry.renderedPoints;
      if (update.renderedPointState) update.geometry.renderedPointState = update.renderedPointState;
      else delete update.geometry.renderedPointState;
      continue;
    }
    if (update.kind === 'alignment-segment') {
      if (update.renderedPoints) update.segment.renderedPoints = update.renderedPoints;
      else delete update.segment.renderedPoints;
      if (update.renderedPointState) update.segment.renderedPointState = update.renderedPointState;
      else delete update.segment.renderedPointState;
      continue;
    }
    const { line } = update;
    if (update.renderedPointState === 'suppressed') {
      delete line.renderedPoints;
      line.renderedPointState = 'suppressed';
    } else if (update.renderedPoints) {
      line.renderedPoints = update.renderedPoints;
      line.renderedPointState = 'aligned';
    } else {
      delete line.renderedPoints;
      delete line.renderedPointState;
    }
  }
}

/**
 * Derive rendered LandXML line points without changing their authored records.
 * LandXML coordinates are absolute survey values, so source RTC is deliberately
 * absent: applying it would translate an already absolute point a second time.
 */
export async function buildLandXmlRenderedLineUpdates(
  document: LandXmlTinDocument,
  source: ModelSpatialReference,
  target: ModelSpatialReference,
  targetOffset: CoordinateInfo | undefined,
): Promise<LandXmlRenderedLineUpdate[]> {
  const allLines = lines(document);
  const clear = () => clearLandXmlRenderedLineUpdates(document);
  if (!document.units || !source.horizontal || !target.horizontal
    || source.vertical?.id !== target.vertical?.id) return clear();

  const sourceProjection = source.horizontal.id === target.horizontal.id
    ? null : await resolveProjectionId(source.horizontal.id);
  const targetProjection = sourceProjection ? await resolveProjectionId(target.horizontal.id) : null;
  if ((sourceProjection && !targetProjection) || (!sourceProjection && source.horizontal.id !== target.horizontal.id)) return clear();
  const sourceProjectedUnit = sourceProjection ? projectedUnitToMetres(sourceProjection) : 1;
  const targetProjectedUnit = targetProjection ? projectedUnitToMetres(targetProjection) : 1;
  if (!sourceProjectedUnit || !targetProjectedUnit) return clear();

  const targetFrame = totalYupOffset(targetOffset);
  const transform = (northing: number, easting: number, elevation: number): [number, number, number] | null => {
    const sourcePoint = [
      easting * document.units!.linearScaleToMeters,
      elevation * document.units!.elevationScaleToMeters,
      -northing * document.units!.linearScaleToMeters,
    ] as const;
    // Overlay vertices ultimately narrow to f32 on the GPU. A finite f64
    // survey value such as 1e100 is still unrenderable.
    if (!sourcePoint.every((value) => Number.isFinite(Math.fround(value)))) return null;
    const projected = localViewerToProjected(source, sourcePoint);
    if (!projected) return null;
    let east = projected[0];
    let north = projected[1];
    if (sourceProjection && targetProjection) {
      try {
        [east, north] = proj4(sourceProjection, targetProjection, [
          east / sourceProjectedUnit,
          north / sourceProjectedUnit,
        ]);
        east *= targetProjectedUnit;
        north *= targetProjectedUnit;
      } catch (error) {
        console.warn('[LandXML] source-record reprojection failed:', error);
        return null;
      }
    }
    const local = projectedToLocalViewer(target, [east, north, projected[2]], targetFrame);
    return local?.every(Number.isFinite) ? [...local] : null;
  };
  const lineUpdates = allLines.map((line): LandXmlRenderedLineUpdate => {
    const elevation = line.coordinateDimension === 2 ? Number(line.properties.elev) : undefined;
    const transformed: number[][] = [];
    for (const point of line.points) {
      const height = point[2] ?? elevation;
      const local = height === undefined || !Number.isFinite(height)
        ? null : transform(point[0], point[1], height);
      if (!local) return { kind: 'line', line, renderedPointState: 'suppressed' };
      transformed.push(local);
    }
    return transformed.length === line.points.length
      ? { kind: 'line', line, renderedPoints: transformed, renderedPointState: 'aligned' }
      : { kind: 'line', line, renderedPointState: 'suppressed' };
  });
  const alignmentUpdates = document.alignments.flatMap((alignment) => alignment.segments.map(
    (segment): LandXmlRenderedLineUpdate => {
      const points = alignmentSegmentPoints(segment);
      if (!points) return { kind: 'alignment-segment', segment, renderedPointState: 'suppressed' };
      const renderedPoints: [number, number, number][] = [];
      for (const point of points) {
        const rendered = transform(point.northing, point.easting, point.elevation ?? 0);
        if (!rendered) return { kind: 'alignment-segment', segment, renderedPointState: 'suppressed' };
        renderedPoints.push(rendered);
      }
      return { kind: 'alignment-segment', segment, renderedPoints, renderedPointState: 'aligned' };
    },
  ));
  const pointUpdates = planPoints(document).map((point): LandXmlRenderedLineUpdate => {
    const renderedPoint = transform(point.northing, point.easting, point.elevation ?? 0);
    return renderedPoint
      ? { kind: 'plan-point', point, renderedPoint, renderedPointState: 'aligned' }
      : { kind: 'plan-point', point, renderedPointState: 'suppressed' };
  });
  const authoredGeometry = planGeometryBySource(document);
  const geometryUpdates = (document.plan?.resolvedGeometry ?? []).map((geometry): LandXmlRenderedLineUpdate => {
    const authored = authoredGeometry.get(geometry.sourceId);
    const points = authored ? planPolyline(authored, geometry) : null;
    if (!points) return { kind: 'plan-geometry', geometry, renderedPointState: 'suppressed' };
    const renderedPoints: [number, number, number][] = [];
    for (const point of points) {
      const rendered = transform(point.northing, point.easting, point.elevation ?? 0);
      if (!rendered) return { kind: 'plan-geometry', geometry, renderedPointState: 'suppressed' };
      renderedPoints.push(rendered);
    }
    return { kind: 'plan-geometry', geometry, renderedPoints, renderedPointState: 'aligned' };
  });
  return [...lineUpdates, ...alignmentUpdates, ...pointUpdates, ...geometryUpdates];
}
