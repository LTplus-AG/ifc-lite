/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Stable, non-IFC LandXML records retained beside the render meshes. */
export interface LandXmlPolyline {
  sourceId: string;
  ordinal: number;
  name: string | null;
  kind: string | null;
  sourcePath: string;
  properties: Record<string, string>;
  coordinateDimension: 2 | 3;
  points: number[][];
  pointSourceIds: string[];
}

export interface LandXmlTinSurface {
  sourceId: string;
  ordinal: number;
  sourcePath: string;
  properties: Record<string, string>;
  definitionProperties: Record<string, string>;
  name: string;
  kind: 'tin' | 'grid' | 'volume' | 'other';
  renderState: 'rendered' | 'preserved_only' | 'unsupported';
  points: Array<{ sourceId: string; id: string; northing: number; easting: number; elevation: number }>;
  sourceDataPoints: Array<{ sourceId: string; ordinal: number; sourcePath: string; coordinateDimension: 2 | 3; coordinates: number[] }>;
  faces: Array<readonly [string, string, string]>;
  faceSourceIds: string[];
  faceVisibility: boolean[];
  hiddenFaceCount: number;
  boundaries: LandXmlPolyline[];
  breaklines: LandXmlPolyline[];
  contours: LandXmlPolyline[];
}

export interface LandXmlTinDocument {
  /** The source format, never an IFC schema alias. */
  format: 'landxml';
  schema: 'LandXML-1.2';
  capabilities: { renderableTin: boolean; preservedOnlySurfaces: number; unknownExtensions: number };
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
  rendering: { meshProvenance: LandXmlMeshProvenance[]; surfaceCounts: LandXmlSurfaceCounts[] };
}

export interface LandXmlSourceRef { modelId: string; sourceId: string }

export interface LandXmlMeshProvenance {
  meshExpressId: number;
  surfaceSourceId: string;
  renderedFaceSourceIds: string[];
}

export interface LandXmlSurfaceCounts {
  surfaceSourceId: string;
  sourcePoints: number;
  sourceFaces: number;
  hiddenFaces: number;
  renderedFaces: number;
  droppedDegenerateFaces: number;
  droppedPrecisionFaces: number;
  droppedReframeFaces: number;
}

export type LandXmlSourceRecord =
  | { kind: 'surface'; surface: LandXmlTinSurface }
  | { kind: 'point'; surface: LandXmlTinSurface; point: LandXmlTinSurface['points'][number] }
  | { kind: 'face'; surface: LandXmlTinSurface; pointIds: readonly [string, string, string] }
  | { kind: 'boundary' | 'breakline' | 'contour'; surface: LandXmlTinSurface; line: LandXmlPolyline };

export interface LandXmlSourceModel { landXmlDocument?: LandXmlTinDocument }

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

/** Federation-safe semantic lookup. Source IDs are document-local by design. */
export function findLandXmlModelSourceRecord(
  models: ReadonlyMap<string, LandXmlSourceModel>, ref: LandXmlSourceRef,
): LandXmlSourceRecord | null {
  const document = models.get(ref.modelId)?.landXmlDocument;
  return document ? findLandXmlSourceRecord(document, ref.sourceId) : null;
}

/** Resolve an actual rendered mesh/triangle pick into a model-qualified source ref. */
export function landXmlPickSourceRef(
  model: LandXmlSourceModel | undefined, modelId: string, meshExpressId: number, triangleIndex?: number,
): LandXmlSourceRef | null {
  const provenance = model?.landXmlDocument?.rendering.meshProvenance.find((mesh) => mesh.meshExpressId === meshExpressId);
  if (!provenance) return null;
  const sourceId = triangleIndex === undefined ? provenance.surfaceSourceId : provenance.renderedFaceSourceIds[triangleIndex];
  return sourceId ? { modelId, sourceId } : null;
}
