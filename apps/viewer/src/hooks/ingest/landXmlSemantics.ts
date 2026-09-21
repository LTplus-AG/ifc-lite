/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Stable, non-IFC LandXML records retained beside the render meshes. */
import type {
  LandXmlMeshProvenance, LandXmlPipe, LandXmlPipeFeature, LandXmlPipeNetwork,
  LandXmlPipeNetworkCollection, LandXmlPipeNetworkDocument, LandXmlPipeStructure,
  LandXmlSurfaceCounts,
} from './landXmlDocumentTypes.js';
import { findLandXmlSourceRecord } from './landXmlSourceIndex.js';
export type * from './landXmlDocumentTypes.js';
export {
  clearLandXmlSourceRecordIndex, findLandXmlSourceRecord, indexLandXmlPlanRecords,
  indexLandXmlSourceRecords, landXmlPlanChildPage, landXmlPlanSourcePage,
} from './landXmlSourceIndex.js';

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
  /** Derived renderer E/U/S metre coordinates after federation reprojection.
   * Authored `points` remain untouched for inspection/export. */
  renderedPoints?: number[][];
  /** Whether an aligned line has points to render or was deliberately suppressed. */
  renderedPointState?: 'aligned' | 'suppressed';
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
  /** Absent only for persisted documents produced before constrained terrain support. */
  topologyOrigin?: 'authored_faces' | 'constrained_triangulation' | 'preserved_only';
  terrainDiagnostic?: { code: string; message: string } | null;
  points: Array<{ sourceId: string; id: string; northing: number; easting: number; elevation: number }>;
  /** Canonical terrain vertices, including every coincident source record that contributed to each one. Absent in persisted pre-triangulation documents. */
  canonicalVertices?: Array<{ id: string; northing: number; easting: number; elevation: number; contributorSourceIds: string[] }>;
  sourceDataPoints: Array<{ sourceId: string; ordinal: number; sourcePath: string; coordinateDimension: 2 | 3; coordinates: number[] }>;
  faces: Array<readonly [string, string, string]>;
  faceSourceIds: string[];
  faceVisibility: boolean[];
  hiddenFaceCount: number;
  boundaries: LandXmlPolyline[];
  breaklines: LandXmlPolyline[];
  contours: LandXmlPolyline[];
}

export interface LandXmlPlanPoint { northing: number; easting: number; elevation: number | null; renderedPoint?: [number, number, number]; renderedPointState?: 'aligned' | 'suppressed' }
export type LandXmlPlanPointLocation =
  | { kind: 'coordinates'; point: LandXmlPlanPoint; pntRef: string | null }
  | { kind: 'point_reference'; pntRef: string };
export interface LandXmlCgPoint {
  sourceId: string; scopeId: string; ordinal: number; name: string | null; code: string | null;
  description: string | null; point: LandXmlPlanPoint | null; pntRef: string | null; properties: Record<string, string>;
}
export interface LandXmlMonument {
  sourceId: string; pointScopeId: string | null; ordinal: number; name: string | null; code: string | null;
  description: string | null; pntRef: string | null; point: LandXmlPlanPoint | null; properties: Record<string, string>;
}
export interface LandXmlPlanGeometry {
  sourceId: string; ordinal: number; kind: 'line' | 'curve' | 'irregular_line'; pointScopeId: string | null;
  start: LandXmlPlanPointLocation; end: LandXmlPlanPointLocation; center: LandXmlPlanPointLocation | null;
  pi: LandXmlPlanPointLocation | null; intermediatePoints: LandXmlPlanPoint[]; rotation: string | null;
  radius: number | null; declaredLength: number | null; properties: Record<string, string>;
}
export interface LandXmlPlanFeature {
  sourceId: string; ordinal: number; name: string | null; code: string | null; description: string | null;
  properties: Record<string, string>; locations: LandXmlPlanPointLocation[]; geometry: LandXmlPlanGeometry[];
}
export interface LandXmlParcel {
  sourceId: string; ordinal: number; name: string | null; code: string | null; description: string | null;
  title: string | null; declaredArea: number | null; declaredPerimeter: number | null; declaredAreaUnit: string | null;
  properties: Record<string, string>; loops: LandXmlPlanGeometry[][]; preservationReason: string | null;
  /** Precomputed at WASM-adapter ingestion; enables direct late-loop paging. */
  loopOffsets: number[];
}
export interface LandXmlParcelProbe {
  sourceId: string;
  state: { kind: 'analytic' } | { kind: 'preserved_only'; reason: string };
  perimeterInDeclaredLinearUnits: number | null; areaInDeclaredSquareUnits: number | null;
  declaredArea: number | null; declaredPerimeter: number | null;
  perimeterInMeters: number | null; areaInSquareMeters: number | null;
}
export interface LandXmlResolvedMonument { sourceId: string; point: LandXmlPlanPoint | null }
export interface LandXmlResolvedGeometry {
  sourceId: string; start: LandXmlPlanPoint | null; end: LandXmlPlanPoint | null;
  center: LandXmlPlanPoint | null; pi: LandXmlPlanPoint | null;
  renderedPoints?: [number, number, number][]; renderedPointState?: 'aligned' | 'suppressed';
}
export interface LandXmlPlanDocument {
  version: string; areaUnit: string | null; areaScaleToSquareMeters: number | null;
  cogoPoints: LandXmlCgPoint[]; monuments: LandXmlMonument[]; planFeatures: LandXmlPlanFeature[];
  parcels: LandXmlParcel[]; warnings: string[];
  /** Rust-created partitions consumed by the one shared plan line overlay. */
  sourceBatches: Array<{ sourceIds: string[] }>;
  parcelProbes: LandXmlParcelProbe[];
  resolvedMonuments: LandXmlResolvedMonument[];
  resolvedGeometry: LandXmlResolvedGeometry[];
  /** An ingestion-built lookup makes source selection independent of record position. */
  sourceRecords?: ReadonlyMap<string, LandXmlSourceRecord>;
  parcelProbesBySource?: ReadonlyMap<string, LandXmlParcelProbe>;
  resolvedMonumentsBySource?: ReadonlyMap<string, LandXmlResolvedMonument>;
  resolvedGeometryBySource?: ReadonlyMap<string, LandXmlResolvedGeometry>;
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
  coordinateSystem?: { horizontalDatum?: string; verticalDatum?: string };
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
  /** Non-terrain semantics from the same canonical Rust/WASM document. */
  plan?: LandXmlPlanDocument;
  pipeNetworks?: LandXmlPipeNetworkDocument | null;
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

export type LandXmlSourceRecord =
  | { kind: 'surface'; surface: LandXmlTinSurface }
  | { kind: 'point'; surface: LandXmlTinSurface; point: LandXmlTinSurface['points'][number] }
  | { kind: 'source-data-point'; surface: LandXmlTinSurface; point: LandXmlTinSurface['sourceDataPoints'][number] }
  | { kind: 'face'; surface: LandXmlTinSurface; pointIds: readonly [string, string, string] }
  | { kind: 'boundary' | 'breakline' | 'contour'; surface: LandXmlTinSurface; line: LandXmlPolyline }
  | { kind: 'alignment'; alignment: LandXmlAlignment }
  | { kind: 'profile'; profile: LandXmlProfile }
  | { kind: 'profile-point'; profile: LandXmlProfile; point: LandXmlProfilePoint }
  | { kind: 'vertical-curve'; profile: LandXmlProfile; curve: LandXmlVerticalCurve }
  | { kind: 'grade-line'; profile: LandXmlProfile; gradeLine: LandXmlGradeLine }
  | { kind: 'grade-line-point'; profile: LandXmlProfile; gradeLine: LandXmlGradeLine; point: LandXmlProfilePoint }
  | { kind: 'cross-section'; crossSection: LandXmlCrossSection }
  | { kind: 'cross-section-surface'; crossSectionSurface: LandXmlCrossSectionSurface }
  | { kind: 'cross-section-segment'; crossSectionSurface: LandXmlCrossSectionSurface; segment: LandXmlCrossSectionSegment }
  | { kind: 'cross-section-point'; crossSectionSurface: LandXmlCrossSectionSurface; point: LandXmlCrossSectionPoint }
  | { kind: 'roadway'; roadway: LandXmlRoadway }
  | { kind: 'preserved-extension'; extension: LandXmlPreservedOnlyExtension }
  | { kind: 'cogo-point'; point: LandXmlCgPoint }
  | { kind: 'monument'; monument: LandXmlMonument }
  | { kind: 'plan-feature'; feature: LandXmlPlanFeature }
  | { kind: 'parcel'; parcel: LandXmlParcel }
  | { kind: 'plan-geometry'; geometry: LandXmlPlanGeometry }
  | { kind: 'pipe'; pipe: LandXmlPipe }
  | { kind: 'pipe-structure'; structure: LandXmlPipeStructure }
  | { kind: 'pipe-feature'; feature: LandXmlPipeFeature }
  | { kind: 'pipe-network'; network: LandXmlPipeNetwork }
  | { kind: 'pipe-network-collection'; collection: LandXmlPipeNetworkCollection };

export interface LandXmlSourceModel { landXmlDocument?: LandXmlTinDocument }

/** The federation resolver capability needed to turn a renderer id into a source model. */
export interface LandXmlPickFederation {
  models: ReadonlyMap<string, LandXmlSourceModel>;
  findModelForGlobalId(globalId: number): string | null;
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
  if (provenance.pipeSourceId) return { modelId, sourceId: provenance.pipeSourceId };
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
