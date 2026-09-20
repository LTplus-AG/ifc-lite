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
  alignments: LandXmlAlignment[];
  profiles: LandXmlProfile[];
  crossSections: LandXmlCrossSection[];
  crossSectionSurfaces: LandXmlCrossSectionSurface[];
  roadways: LandXmlRoadway[];
  capabilityDiagnostics: LandXmlCapabilityDiagnostic[];
  preservedOnlyExtensions: LandXmlPreservedOnlyExtension[];
  rendering: { meshProvenance: LandXmlMeshProvenance[]; surfaceCounts: LandXmlSurfaceCounts[] };
}

export interface LandXmlAlignment { sourceId: string; ordinal: number; name: string; length: number; staStart: number; profileSourceIds: string[]; crossSectionSourceIds: string[] }
export interface LandXmlProfilePoint { sourceId: string; station: number; elevation: number | null }
export interface LandXmlGradeLine { sourceId: string; parentProfileSourceId: string; ordinal: number; points: LandXmlProfilePoint[] }
export interface LandXmlVerticalCurve { sourceId: string; parentProfileSourceId: string; kind: 'parabolic' | 'unsymmetrical_parabolic' | 'circular'; station: number; elevation: number | null; length: number | null; lengthIn: number | null; lengthOut: number | null; radius: number | null }
export interface LandXmlProfile { sourceId: string; parentAlignmentSourceId: string; ordinal: number; name: string; kind: 'design' | 'sampled'; pvis: LandXmlProfilePoint[]; verticalCurves: LandXmlVerticalCurve[]; gradeLines: LandXmlGradeLine[] }
export interface LandXmlCrossSection { sourceId: string; parentAlignmentSourceId: string; ordinal: number; station: number; surfaceSourceIds: string[] }
export interface LandXmlCrossSectionPoint { sourceId: string; dataFormat: 'offset_elevation' | 'slope_distance'; offset: number | null; elevation: number | null; slope: number | null; distance: number | null; pntRef: string | null; alignmentRef: string | null; alignRefStation: number | null; alignmentSourceId: string | null; planFeatureRef: string | null; planFeatureRefStation: number | null; parcelRef: string | null; parcelRefStation: number | null }
export interface LandXmlCrossSectionSegment { sourceId: string; parentSurfaceSourceId: string; ordinal: number; points: LandXmlCrossSectionPoint[] }
export interface LandXmlCrossSectionSurface { sourceId: string; parentCrossSectionSourceId: string; kind: 'sampled' | 'design'; name: string | null; segments: LandXmlCrossSectionSegment[]; points: LandXmlCrossSectionPoint[] }
export interface LandXmlRoadway { sourceId: string; ordinal: number; name: string; alignmentRefs: string[]; alignmentSourceIds: string[]; surfaceRefs: string[]; surfaceSourceIds: string[]; gradeModelRefs: string[] }
export interface LandXmlCapabilityDiagnostic { code: string; sourceId: string | null; sourcePath: string; message: string }
export interface LandXmlPreservedOnlyExtension { sourceId: string; parentSourceId: string | null; localName: string; sourcePath: string; kind: 'corridor' | 'string_line' }

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
  | { kind: 'profile'; profile: LandXmlProfile }
  | { kind: 'cross-section'; crossSection: LandXmlCrossSection }
  | { kind: 'cross-section-surface'; crossSectionSurface: LandXmlCrossSectionSurface }
  | { kind: 'roadway'; roadway: LandXmlRoadway }
  | { kind: 'preserved-extension'; extension: LandXmlPreservedOnlyExtension };

export interface LandXmlSourceModel { landXmlDocument?: LandXmlTinDocument }

/** The federation resolver capability needed to turn a renderer id into a source model. */
export interface LandXmlPickFederation {
  models: ReadonlyMap<string, LandXmlSourceModel>;
  findModelForGlobalId(globalId: number): string | null;
}

/** Resolve source data without relying on a renderer or IFC identifier. */
export function findLandXmlSourceRecord(document: LandXmlTinDocument, sourceId: string): LandXmlSourceRecord | null {
  const alignment = document.alignments.find((candidate) => candidate.sourceId === sourceId);
  if (alignment) return { kind: 'alignment', alignment };
  const profile = document.profiles.find((candidate) => candidate.sourceId === sourceId);
  if (profile) return { kind: 'profile', profile };
  const crossSection = document.crossSections.find((candidate) => candidate.sourceId === sourceId);
  if (crossSection) return { kind: 'cross-section', crossSection };
  const crossSectionSurface = document.crossSectionSurfaces.find((candidate) => candidate.sourceId === sourceId);
  if (crossSectionSurface) return { kind: 'cross-section-surface', crossSectionSurface };
  const roadway = document.roadways.find((candidate) => candidate.sourceId === sourceId);
  if (roadway) return { kind: 'roadway', roadway };
  const extension = document.preservedOnlyExtensions.find((candidate) => candidate.sourceId === sourceId);
  if (extension) return { kind: 'preserved-extension', extension };
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
