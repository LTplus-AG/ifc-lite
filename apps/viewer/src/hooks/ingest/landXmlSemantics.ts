/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Stable, non-IFC LandXML records retained beside the render meshes. */
export interface LandXmlPolyline {
  sourceId: string;
  name: string | null;
  kind: string | null;
  points: Array<readonly [number, number, number]>;
}

export interface LandXmlTinSurface {
  sourceId: string;
  name: string;
  kind: 'tin' | 'grid' | 'volume' | 'other';
  renderState: 'rendered' | 'preserved_only' | 'unsupported';
  points: Array<{ sourceId: string; id: string; northing: number; easting: number; elevation: number }>;
  faces: Array<readonly [string, string, string]>;
  faceSourceIds: string[];
  hiddenFaceCount: number;
  boundaries: LandXmlPolyline[];
  breaklines: LandXmlPolyline[];
  contours: LandXmlPolyline[];
}

export interface LandXmlTinDocument {
  version: string;
  units: {
    linearUnit: string;
    elevationUnit: string;
    linearScaleToMeters: number;
    elevationScaleToMeters: number;
  } | null;
  surfaces: LandXmlTinSurface[];
  extensions: Array<{ namespace: string; localName: string; path: string }>;
  warnings: string[];
}

export type LandXmlSourceRecord =
  | { kind: 'surface'; surface: LandXmlTinSurface }
  | { kind: 'point'; surface: LandXmlTinSurface; point: LandXmlTinSurface['points'][number] }
  | { kind: 'face'; surface: LandXmlTinSurface; pointIds: readonly [string, string, string] }
  | { kind: 'boundary' | 'breakline' | 'contour'; surface: LandXmlTinSurface; line: LandXmlPolyline };

/** Resolve source data without relying on a renderer or IFC identifier. */
export function findLandXmlSourceRecord(document: LandXmlTinDocument, sourceId: string): LandXmlSourceRecord | null {
  for (const surface of document.surfaces) {
    if (surface.sourceId === sourceId) return { kind: 'surface', surface };
    const point = surface.points.find((candidate) => candidate.sourceId === sourceId);
    if (point) return { kind: 'point', surface, point };
    const faceIndex = surface.faceSourceIds.indexOf(sourceId);
    const pointIds = faceIndex >= 0 ? surface.faces[faceIndex] : undefined;
    if (pointIds) return { kind: 'face', surface, pointIds };
    for (const [kind, lines] of [
      ['boundary', surface.boundaries], ['breakline', surface.breaklines], ['contour', surface.contours],
    ] as const) {
      const line = lines.find((candidate) => candidate.sourceId === sourceId);
      if (line) return { kind, surface, line };
    }
  }
  return null;
}
