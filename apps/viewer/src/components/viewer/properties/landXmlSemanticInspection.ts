/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LandXmlSourceRecord } from '@/hooks/ingest/landXmlSemantics';

export type SemanticDetailRow = { label: string; value: string; sourceId?: string };
export type SemanticNavigationItem = { label: string; sourceId?: string };

type SemanticRecord = Exclude<LandXmlSourceRecord, {
  kind: 'surface' | 'point' | 'source-data-point' | 'face' | 'boundary' | 'breakline' | 'contour'
    | 'alignment-segment' | 'unsupported-transition'
    | 'cogo-point' | 'monument' | 'plan-feature' | 'parcel' | 'plan-geometry'
    | 'pipe' | 'pipe-structure' | 'pipe-feature' | 'pipe-network' | 'pipe-network-collection';
}>;

function association(label: string, sourceId: string): SemanticNavigationItem {
  return { label: `${label}: ${sourceId}`, sourceId };
}

/** Count source-owned navigation records without materializing relationship arrays. */
export function semanticNavigationCount(record: SemanticRecord): number {
  switch (record.kind) {
    case 'alignment': return record.alignment.profileSourceIds.length + record.alignment.crossSectionSourceIds.length;
    case 'profile': return 1 + record.profile.pvis.length + record.profile.verticalCurves.length + record.profile.gradeLines.length;
    case 'profile-point': case 'vertical-curve': return 1;
    case 'grade-line': return 1 + record.gradeLine.points.length;
    case 'grade-line-point': return 1;
    case 'cross-section': return 1 + record.crossSection.surfaceSourceIds.length;
    case 'cross-section-surface': return 1 + record.crossSectionSurface.segments.length + record.crossSectionSurface.points.length;
    case 'cross-section-segment': return 1 + record.segment.points.length;
    case 'cross-section-point': return 1;
    case 'roadway': return record.roadway.alignmentSourceIds.length + record.roadway.surfaceSourceIds.length + record.roadway.gradeModelRefs.length;
    case 'preserved-extension': return record.extension.parentSourceId ? 1 : 0;
  }
}

/** Return exactly one child or schema-grounded association by index. */
export function semanticNavigationAt(record: SemanticRecord, itemIndex: number): SemanticNavigationItem {
  let index = itemIndex;
  switch (record.kind) {
    case 'alignment': {
      const profile = record.alignment.profileSourceIds[index];
      if (profile) return association('Profile', profile);
      index -= record.alignment.profileSourceIds.length;
      const crossSection = record.alignment.crossSectionSourceIds[index];
      if (crossSection) return association('Cross section', crossSection);
      break;
    }
    case 'profile': {
      if (index === 0) return association('Parent alignment', record.profile.parentAlignmentSourceId);
      index -= 1;
      const point = record.profile.pvis[index];
      if (point) return { label: `PVI: sta ${point.station}`, sourceId: point.sourceId };
      index -= record.profile.pvis.length;
      const curve = record.profile.verticalCurves[index];
      if (curve) return { label: `${curve.kind}: sta ${curve.station}`, sourceId: curve.sourceId };
      index -= record.profile.verticalCurves.length;
      const gradeLine = record.profile.gradeLines[index];
      if (gradeLine) return { label: `Grade line ${gradeLine.ordinal}`, sourceId: gradeLine.sourceId };
      break;
    }
    case 'profile-point': return association('Profile', record.profile.sourceId);
    case 'vertical-curve': return association('Profile', record.profile.sourceId);
    case 'grade-line': {
      if (index === 0) return association('Profile', record.profile.sourceId);
      const point = record.gradeLine.points[index - 1];
      if (point) return { label: `Grade sample: sta ${point.station}`, sourceId: point.sourceId };
      break;
    }
    case 'grade-line-point': return association('Grade line', record.gradeLine.sourceId);
    case 'cross-section': {
      if (index === 0) return association('Parent alignment', record.crossSection.parentAlignmentSourceId);
      const surface = record.crossSection.surfaceSourceIds[index - 1];
      if (surface) return association('Cross-section surface', surface);
      break;
    }
    case 'cross-section-surface': {
      if (index === 0) return association('Parent cross section', record.crossSectionSurface.parentCrossSectionSourceId);
      index -= 1;
      const segment = record.crossSectionSurface.segments[index];
      if (segment) return { label: `Segment ${segment.ordinal}`, sourceId: segment.sourceId };
      index -= record.crossSectionSurface.segments.length;
      const point = record.crossSectionSurface.points[index];
      if (point) return { label: `Cross-section point: offset ${point.offset ?? 'unresolved'}`, sourceId: point.sourceId };
      break;
    }
    case 'cross-section-segment': {
      if (index === 0) return association('Cross-section surface', record.crossSectionSurface.sourceId);
      const point = record.segment.points[index - 1];
      if (point) return { label: `Cross-section point: offset ${point.offset ?? 'unresolved'}`, sourceId: point.sourceId };
      break;
    }
    case 'cross-section-point': return association('Cross-section surface', record.crossSectionSurface.sourceId);
    case 'roadway': {
      const alignment = record.roadway.alignmentSourceIds[index];
      if (alignment) return association('Alignment', alignment);
      index -= record.roadway.alignmentSourceIds.length;
      const surface = record.roadway.surfaceSourceIds[index];
      if (surface) return association('Terrain surface', surface);
      index -= record.roadway.surfaceSourceIds.length;
      const gradeModel = record.roadway.gradeModelRefs[index];
      if (gradeModel) return { label: `Unsupported GradeModel: ${gradeModel}` };
      break;
    }
    case 'preserved-extension': if (record.extension.parentSourceId) return association('Parent source', record.extension.parentSourceId);
  }
  throw new Error(`LandXML semantic navigation index ${itemIndex} is outside the retained record`);
}

/** Engineering values for one selected record; child collections stay in the pager. */
export function semanticDetailRows(record: SemanticRecord): SemanticDetailRow[] {
  switch (record.kind) {
    case 'alignment': return [
      { label: 'Length', value: String(record.alignment.length) },
      { label: 'Start station', value: String(record.alignment.staStart) },
    ];
    case 'profile': return [
      { label: 'Profile kind', value: record.profile.kind },
      { label: 'PVIs', value: String(record.profile.pvis.length) },
      { label: 'Vertical curves', value: String(record.profile.verticalCurves.length) },
      { label: 'Sampled grade lines', value: String(record.profile.gradeLines.length) },
    ];
    case 'profile-point': return profilePointRows(record.point.station, record.point.elevation);
    case 'vertical-curve': return [
      { label: 'Curve kind', value: record.curve.kind },
      ...profilePointRows(record.curve.station, record.curve.elevation),
      { label: 'Length', value: optionalNumber(record.curve.length) },
      { label: 'Incoming length', value: optionalNumber(record.curve.lengthIn) },
      { label: 'Outgoing length', value: optionalNumber(record.curve.lengthOut) },
      { label: 'Radius', value: optionalNumber(record.curve.radius) },
    ];
    case 'grade-line': return [{ label: 'Ordinal', value: String(record.gradeLine.ordinal) }, { label: 'Samples', value: String(record.gradeLine.points.length) }];
    case 'grade-line-point': return profilePointRows(record.point.station, record.point.elevation);
    case 'cross-section': return [{ label: 'Station', value: String(record.crossSection.station) }, { label: 'Surfaces', value: String(record.crossSection.surfaceSourceIds.length) }];
    case 'cross-section-surface': return [{ label: 'Surface kind', value: record.crossSectionSurface.kind }, { label: 'Segments', value: String(record.crossSectionSurface.segments.length) }, { label: 'Points', value: String(record.crossSectionSurface.points.length) }];
    case 'cross-section-segment': return [{ label: 'Ordinal', value: String(record.segment.ordinal) }, { label: 'Points', value: String(record.segment.points.length) }];
    case 'cross-section-point': return crossSectionPointRows(record.point);
    case 'roadway': return [{ label: 'Alignments', value: String(record.roadway.alignmentSourceIds.length) }, { label: 'Terrain surfaces', value: String(record.roadway.surfaceSourceIds.length) }, { label: 'Unsupported GradeModel references', value: String(record.roadway.gradeModelRefs.length) }];
    case 'preserved-extension': return [{ label: 'Extension kind', value: record.extension.kind }];
  }
}

function profilePointRows(station: number, elevation: number | null): SemanticDetailRow[] {
  return [{ label: 'Station', value: String(station) }, { label: 'Elevation', value: optionalNumber(elevation) }];
}

function crossSectionPointRows(point: Extract<LandXmlSourceRecord, { kind: 'cross-section-point' }>['point']): SemanticDetailRow[] {
  return [
    { label: 'Data format', value: point.dataFormat },
    { label: 'Signed offset', value: optionalNumber(point.offset) },
    { label: 'Elevation', value: optionalNumber(point.elevation) },
    { label: 'Slope', value: optionalNumber(point.slope) },
    { label: 'Distance', value: optionalNumber(point.distance) },
    { label: 'Point reference', value: point.pntRef ?? 'unresolved' },
    { label: 'Alignment reference', value: point.alignmentRef ?? 'unresolved' },
    ...(point.alignmentSourceId ? [{ label: 'Resolved alignment', value: point.alignmentSourceId, sourceId: point.alignmentSourceId }] : []),
    { label: 'Alignment reference station', value: optionalNumber(point.alignRefStation) },
    { label: 'Plan feature reference', value: point.planFeatureRef ?? 'unresolved' },
    { label: 'Parcel reference', value: point.parcelRef ?? 'unresolved' },
  ];
}

function optionalNumber(value: number | null): string {
  return value === null ? 'unresolved' : String(value);
}
