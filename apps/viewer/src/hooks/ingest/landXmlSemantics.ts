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
  /** Horizontal source geometry remains a semantic record, never synthetic IFC. */
  alignments?: LandXmlAlignment[];
}

export interface LandXmlPlanPoint { northing: number; easting: number; elevation: number | null }
export type LandXmlPointLocation = { kind: 'coordinates'; point: LandXmlPlanPoint } | { kind: 'point_reference'; pntRef: string };
export interface LandXmlAlignmentSegment { sourceId: string; ordinal: number; primitive: LandXmlAlignmentPrimitive }
export type LandXmlAlignmentPrimitive =
  | { kind: 'line'; start: LandXmlPointLocation; end: LandXmlPointLocation; declaredLength: number | null }
  | { kind: 'irregular_line'; start: LandXmlPointLocation; end: LandXmlPointLocation; points: LandXmlPlanPoint[]; declaredLength: number | null }
  | { kind: 'curve'; start: LandXmlPointLocation; center: LandXmlPointLocation; end: LandXmlPointLocation; rotation: 'clockwise' | 'counter_clockwise'; radius: number | null; declaredLength: number | null }
  | { kind: 'spiral' | 'unsupported_spiral'; start: LandXmlPointLocation; pi: LandXmlPointLocation; end: LandXmlPointLocation; spiType: string; declaredLength: number };
export interface LandXmlAlignment {
  sourceId: string;
  ordinal: number;
  name: string;
  length: number;
  staStart: number;
  segments: LandXmlAlignmentSegment[];
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
  | { kind: 'source-data-point'; surface: LandXmlTinSurface; point: LandXmlTinSurface['sourceDataPoints'][number] }
  | { kind: 'face'; surface: LandXmlTinSurface; pointIds: readonly [string, string, string] }
  | { kind: 'boundary' | 'breakline' | 'contour'; surface: LandXmlTinSurface; line: LandXmlPolyline }
  | { kind: 'alignment'; alignment: LandXmlAlignment }
  | { kind: 'alignment-segment'; alignment: LandXmlAlignment; segment: LandXmlAlignmentSegment };

export interface LandXmlSourceModel { landXmlDocument?: LandXmlTinDocument }

/** The federation resolver capability needed to turn a renderer id into a source model. */
export interface LandXmlPickFederation {
  models: ReadonlyMap<string, LandXmlSourceModel>;
  findModelForGlobalId(globalId: number): string | null;
}

/** Resolve source data without relying on a renderer or IFC identifier. */
export function findLandXmlSourceRecord(document: LandXmlTinDocument, sourceId: string): LandXmlSourceRecord | null {
  for (const alignment of document.alignments ?? []) {
    if (alignment.sourceId === sourceId) return { kind: 'alignment', alignment };
    const segment = alignment.segments.find((candidate) => candidate.sourceId === sourceId);
    if (segment) return { kind: 'alignment-segment', alignment, segment };
  }
  for (const surface of document.surfaces) {
    if (surface.sourceId === sourceId) return { kind: 'surface', surface };
    const point = surface.points.find((candidate) => candidate.sourceId === sourceId);
    if (point) return { kind: 'point', surface, point };
    const sourceDataPoint = surface.sourceDataPoints.find((candidate) => candidate.sourceId === sourceId);
    if (sourceDataPoint) return { kind: 'source-data-point', surface, point: sourceDataPoint };
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

/**
 * Resolve a renderer pick through the federation registry before consulting
 * document-local LandXML provenance. `PickResult` has no triangle index, so a
 * terrain click truthfully resolves to its source surface until that contract
 * grows a triangle identity channel.
 */
export function landXmlPickSourceRefFromFederation(
  federation: LandXmlPickFederation,
  meshExpressId: number,
  triangleIndex?: number,
): LandXmlSourceRef | null {
  const modelId = federation.findModelForGlobalId(meshExpressId);
  return modelId === null
    ? null
    : landXmlPickSourceRef(federation.models.get(modelId), modelId, meshExpressId, triangleIndex);
}
