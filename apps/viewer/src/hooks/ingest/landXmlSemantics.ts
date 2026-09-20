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

export interface LandXmlPlanPoint { northing: number; easting: number; elevation: number | null }
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
}
export interface LandXmlPlanDocument {
  version: string; areaUnit: string | null; areaScaleToSquareMeters: number | null;
  cogoPoints: LandXmlCgPoint[]; monuments: LandXmlMonument[]; planFeatures: LandXmlPlanFeature[];
  parcels: LandXmlParcel[]; warnings: string[];
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
  /** Non-terrain semantics from the same canonical Rust/WASM document. */
  plan?: LandXmlPlanDocument;
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
  | { kind: 'plan-geometry'; geometry: LandXmlPlanGeometry };

export interface LandXmlSourceModel { landXmlDocument?: LandXmlTinDocument }

/** The federation resolver capability needed to turn a renderer id into a source model. */
export interface LandXmlPickFederation {
  models: ReadonlyMap<string, LandXmlSourceModel>;
  findModelForGlobalId(globalId: number): string | null;
}

interface LandXmlSourceRecordIndex {
  roots: Map<string, LandXmlSourceRecord>;
  records: Map<string, LandXmlSourceRecord>;
  complete: boolean;
}

const sourceRecordIndexes = new WeakMap<LandXmlTinDocument, LandXmlSourceRecordIndex>();

function sourceRecordIndex(document: LandXmlTinDocument): LandXmlSourceRecordIndex {
  const existing = sourceRecordIndexes.get(document);
  if (existing) return existing;
  const index: LandXmlSourceRecordIndex = { roots: new Map(), records: new Map(), complete: false };
  for (const alignment of document.alignments) index.roots.set(alignment.sourceId, { kind: 'alignment', alignment });
  for (const profile of document.profiles) index.roots.set(profile.sourceId, { kind: 'profile', profile });
  for (const crossSection of document.crossSections) index.roots.set(crossSection.sourceId, { kind: 'cross-section', crossSection });
  for (const crossSectionSurface of document.crossSectionSurfaces) index.roots.set(crossSectionSurface.sourceId, { kind: 'cross-section-surface', crossSectionSurface });
  for (const roadway of document.roadways) index.roots.set(roadway.sourceId, { kind: 'roadway', roadway });
  for (const extension of document.preservedOnlyExtensions) index.roots.set(extension.sourceId, { kind: 'preserved-extension', extension });
  for (const point of document.plan?.cogoPoints ?? []) index.roots.set(point.sourceId, { kind: 'cogo-point', point });
  for (const monument of document.plan?.monuments ?? []) index.roots.set(monument.sourceId, { kind: 'monument', monument });
  for (const feature of document.plan?.planFeatures ?? []) index.roots.set(feature.sourceId, { kind: 'plan-feature', feature });
  for (const parcel of document.plan?.parcels ?? []) index.roots.set(parcel.sourceId, { kind: 'parcel', parcel });
  for (const surface of document.surfaces) index.roots.set(surface.sourceId, { kind: 'surface', surface });
  sourceRecordIndexes.set(document, index);
  return index;
}

/** Build the bounded source-ID lookup once at ingest; later selection is O(1). */
export function indexLandXmlSourceRecords(document: LandXmlTinDocument): void {
  const index = sourceRecordIndex(document);
  if (index.complete) return;
  for (const [sourceId, record] of index.roots) index.records.set(sourceId, record);
  for (const profile of document.profiles) {
    for (const point of profile.pvis) index.records.set(point.sourceId, { kind: 'profile-point', profile, point });
    for (const curve of profile.verticalCurves) index.records.set(curve.sourceId, { kind: 'vertical-curve', profile, curve });
    for (const gradeLine of profile.gradeLines) {
      index.records.set(gradeLine.sourceId, { kind: 'grade-line', profile, gradeLine });
      for (const point of gradeLine.points) index.records.set(point.sourceId, { kind: 'grade-line-point', profile, gradeLine, point });
    }
  }
  for (const crossSectionSurface of document.crossSectionSurfaces) {
    for (const point of crossSectionSurface.points) index.records.set(point.sourceId, { kind: 'cross-section-point', crossSectionSurface, point });
    for (const segment of crossSectionSurface.segments) {
      index.records.set(segment.sourceId, { kind: 'cross-section-segment', crossSectionSurface, segment });
      for (const point of segment.points) index.records.set(point.sourceId, { kind: 'cross-section-point', crossSectionSurface, point });
    }
  }
  for (const surface of document.surfaces) {
    for (const point of surface.points) index.records.set(point.sourceId, { kind: 'point', surface, point });
    for (const point of surface.sourceDataPoints) index.records.set(point.sourceId, { kind: 'source-data-point', surface, point });
    for (const [faceIndex, faceSourceId] of surface.faceSourceIds.entries()) {
      const pointIds = surface.faces[faceIndex];
      if (pointIds) index.records.set(faceSourceId, { kind: 'face', surface, pointIds });
    }
    for (const [kind, lines] of [
      ['boundary', surface.boundaries], ['breakline', surface.breaklines], ['contour', surface.contours],
    ] as const) {
      for (const line of lines) index.records.set(line.sourceId, { kind, surface, line });
    }
  }
  for (const feature of document.plan?.planFeatures ?? []) {
    for (const geometry of feature.geometry) index.records.set(geometry.sourceId, { kind: 'plan-geometry', geometry });
  }
  for (const parcel of document.plan?.parcels ?? []) {
    for (const loop of parcel.loops) {
      for (const geometry of loop) index.records.set(geometry.sourceId, { kind: 'plan-geometry', geometry });
    }
  }
  index.complete = true;
}

/** Release a document's index when a host explicitly discards its source model. */
export function clearLandXmlSourceRecordIndex(document: LandXmlTinDocument): void {
  sourceRecordIndexes.delete(document);
}

/** Resolve source data without walking retained geometry on every selection. */
export function findLandXmlSourceRecord(document: LandXmlTinDocument, sourceId: string): LandXmlSourceRecord | null {
  const index = sourceRecordIndex(document);
  const root = index.roots.get(sourceId);
  if (root) return root;
  indexLandXmlSourceRecords(document);
  return index.records.get(sourceId) ?? null;
}

/**
 * Return one bounded page of top-level plan records. Geometry remains nested
 * beneath its feature or parcel, so opening the source navigator never
 * materializes a second array proportional to every analytic primitive.
 */
export function landXmlPlanSourcePage(
  document: LandXmlTinDocument,
  offset: number,
  limit: number,
): { total: number; sourceIds: string[] } {
  const plan = document.plan;
  if (!plan || limit <= 0) return { total: 0, sourceIds: [] };
  const records = [plan.cogoPoints, plan.monuments, plan.planFeatures, plan.parcels] as const;
  const total = records.reduce((count, group) => count + group.length, 0);
  let index = 0;
  const sourceIds: string[] = [];
  for (const group of records) {
    for (const record of group) {
      if (index >= offset && sourceIds.length < limit) sourceIds.push(record.sourceId);
      index++;
    }
  }
  return { total, sourceIds };
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
