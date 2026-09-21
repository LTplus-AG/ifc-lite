/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Rebuild immutable LandXML line records into a federated render frame. */

import { localViewerToProjected, projectedToLocalViewer, type CoordinateInfo, type ModelSpatialReference } from '@ifc-lite/geometry';
import proj4 from 'proj4';
import { totalYupOffset } from '../../lib/geo/coordinate-frame.js';
import { resolveProjectionId } from '../../lib/geo/reproject.js';
import { projectedUnitToMetres } from './projected-units.js';
import type { LandXmlPolyline, LandXmlTinDocument } from './landXmlSemantics.js';

export interface LandXmlRenderedLineUpdate {
  line: LandXmlPolyline;
  renderedPoints?: number[][];
  renderedPointState?: 'aligned' | 'suppressed';
}

function lines(document: LandXmlTinDocument): LandXmlPolyline[] {
  return document.surfaces.flatMap((surface) => [
    ...surface.boundaries, ...surface.breaklines, ...surface.contours,
  ]);
}

/** Clear derived points when a source is no longer aligned to an anchor. */
export function clearLandXmlRenderedLineUpdates(document: LandXmlTinDocument): LandXmlRenderedLineUpdate[] {
  return lines(document).map((line) => ({ line }));
}

/** Apply a prepared result only after its whole rebuild has succeeded. */
export function applyLandXmlRenderedLineUpdates(updates: readonly LandXmlRenderedLineUpdate[]): void {
  for (const { line, renderedPoints, renderedPointState } of updates) {
    if (renderedPointState === 'suppressed') {
      delete line.renderedPoints;
      line.renderedPointState = 'suppressed';
    } else if (renderedPoints) {
      line.renderedPoints = renderedPoints;
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
  return allLines.map((line) => {
    const elevation = line.coordinateDimension === 2 ? Number(line.properties.elev) : undefined;
    const transformed: number[][] = [];
    for (const point of line.points) {
      const height = point[2] ?? elevation;
      if (height === undefined || !Number.isFinite(height)) return { line, renderedPointState: 'suppressed' };
      const sourcePoint = [
        point[1] * document.units!.linearScaleToMeters,
        height * document.units!.elevationScaleToMeters,
        -point[0] * document.units!.linearScaleToMeters,
      ] as const;
      // Overlay vertices ultimately narrow to f32 on the GPU. A finite f64
      // survey value such as 1e100 is still unrenderable; publishing it as an
      // "aligned" line would later fall back to the source coordinates.
      if (!sourcePoint.every((value) => Number.isFinite(Math.fround(value)))) {
        return { line, renderedPointState: 'suppressed' };
      }
      const projected = localViewerToProjected(source, sourcePoint);
      if (!projected) return { line, renderedPointState: 'suppressed' };
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
          console.warn('[LandXML] line reprojection failed:', error);
          return { line, renderedPointState: 'suppressed' };
        }
      }
      const local = projectedToLocalViewer(target, [east, north, projected[2]], targetFrame);
      if (!local?.every(Number.isFinite)) return { line, renderedPointState: 'suppressed' };
      transformed.push([...local]);
    }
    return transformed.length === line.points.length
      ? { line, renderedPoints: transformed, renderedPointState: 'aligned' }
      : { line, renderedPointState: 'suppressed' };
  });
}
