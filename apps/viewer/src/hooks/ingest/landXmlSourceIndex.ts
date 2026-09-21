/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Bounded source-record indexes and plan navigation for LandXML documents. */
import type { LandXmlPlanDocument, LandXmlSourceRecord, LandXmlTinDocument } from './landXmlSemantics.js';

/** Build the one-time plan lookup while adapting WASM, never during UI selection. */
export function indexLandXmlPlanRecords(plan: LandXmlPlanDocument): ReadonlyMap<string, LandXmlSourceRecord> {
  const records = new Map<string, LandXmlSourceRecord>();
  for (const point of plan.cogoPoints) records.set(point.sourceId, { kind: 'cogo-point', point });
  for (const monument of plan.monuments) records.set(monument.sourceId, { kind: 'monument', monument });
  for (const feature of plan.planFeatures) {
    records.set(feature.sourceId, { kind: 'plan-feature', feature });
    for (const geometry of feature.geometry) records.set(geometry.sourceId, { kind: 'plan-geometry', geometry });
  }
  for (const parcel of plan.parcels) {
    records.set(parcel.sourceId, { kind: 'parcel', parcel });
    for (const loop of parcel.loops) for (const geometry of loop) records.set(geometry.sourceId, { kind: 'plan-geometry', geometry });
  }
  return records;
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
  for (const collection of document.pipeNetworks?.collections ?? []) {
    index.roots.set(collection.sourceId, { kind: 'pipe-network-collection', collection });
  }
  for (const network of document.pipeNetworks?.networks ?? []) {
    index.roots.set(network.sourceId, { kind: 'pipe-network', network });
    for (const pipe of network.pipes) index.roots.set(pipe.sourceId, { kind: 'pipe', pipe });
    for (const structure of network.structures) index.roots.set(structure.sourceId, { kind: 'pipe-structure', structure });
    for (const feature of network.features) index.roots.set(feature.sourceId, { kind: 'pipe-feature', feature });
  }
  for (const feature of document.pipeNetworks?.features ?? []) index.roots.set(feature.sourceId, { kind: 'pipe-feature', feature });
  for (const surface of document.surfaces) index.roots.set(surface.sourceId, { kind: 'surface', surface });
  sourceRecordIndexes.set(document, index);
  return index;
}

/** Build the bounded source-ID lookup once at ingest; later selection is O(1). */
export function indexLandXmlSourceRecords(document: LandXmlTinDocument): void {
  const index = sourceRecordIndex(document);
  if (index.complete) return;
  for (const [sourceId, record] of index.roots) index.records.set(sourceId, record);
  for (const alignment of document.alignments) {
    for (const segment of alignment.segments ?? []) {
      index.records.set(segment.sourceId, { kind: 'alignment-segment', alignment, segment });
    }
    for (const transition of alignment.unsupportedTransitions ?? []) {
      index.records.set(transition.sourceId, { kind: 'unsupported-transition', alignment, transition });
    }
  }
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
  if (document.plan?.sourceRecords) {
    for (const [sourceId, record] of document.plan.sourceRecords) index.records.set(sourceId, record);
  } else {
    for (const feature of document.plan?.planFeatures ?? []) {
      for (const geometry of feature.geometry) index.records.set(geometry.sourceId, { kind: 'plan-geometry', geometry });
    }
    for (const parcel of document.plan?.parcels ?? []) {
      for (const loop of parcel.loops) {
        for (const geometry of loop) index.records.set(geometry.sourceId, { kind: 'plan-geometry', geometry });
      }
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
  const indexedPlan = document.plan?.sourceRecords?.get(sourceId);
  if (indexedPlan) return indexedPlan;
  const index = sourceRecordIndex(document);
  const root = index.roots.get(sourceId);
  if (root) return root;
  indexLandXmlSourceRecords(document);
  return index.records.get(sourceId) ?? null;
}

interface NavigationPage { total: number; sourceIds: string[] }

/** Return one direct, bounded geometry page for a plan feature or parcel. */
export function landXmlPlanChildPage(record: Extract<LandXmlSourceRecord, { kind: 'plan-feature' | 'parcel' }>, offset: number, limit: number): NavigationPage {
  const start = Math.max(0, offset);
  if (limit <= 0) return { total: 0, sourceIds: [] };
  if (record.kind === 'plan-feature') {
    return { total: record.feature.geometry.length, sourceIds: record.feature.geometry.slice(start, start + limit).map((geometry) => geometry.sourceId) };
  }
  const offsets = record.parcel.loopOffsets;
  const lastLoop = record.parcel.loops.length - 1;
  const total = lastLoop < 0 ? 0 : offsets[lastLoop] + record.parcel.loops[lastLoop].length;
  if (start >= total) return { total, sourceIds: [] };
  let lower = 0;
  let upper = offsets.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (offsets[middle] <= start) lower = middle + 1;
    else upper = middle;
  }
  let loopIndex = lower - 1;
  let index = start - offsets[loopIndex];
  const sourceIds: string[] = [];
  while (loopIndex < record.parcel.loops.length && sourceIds.length < limit) {
    const loop = record.parcel.loops[loopIndex];
    const take = Math.min(limit - sourceIds.length, loop.length - index);
    for (const geometry of loop.slice(index, index + take)) sourceIds.push(geometry.sourceId);
    loopIndex += 1;
    index = 0;
  }
  return { total, sourceIds };
}

/** Return one bounded page of top-level plan records without flattening child geometry. */
export function landXmlPlanSourcePage(document: LandXmlTinDocument, offset: number, limit: number): NavigationPage {
  const plan = document.plan;
  if (!plan || limit <= 0) return { total: 0, sourceIds: [] };
  const records = [plan.cogoPoints, plan.monuments, plan.planFeatures, plan.parcels] as const;
  const total = records.reduce((count, group) => count + group.length, 0);
  const start = Math.max(0, offset);
  const end = Math.min(total, start + limit);
  const sourceIds: string[] = [];
  let groupStart = 0;
  for (const group of records) {
    const from = Math.max(0, start - groupStart);
    const to = Math.min(group.length, end - groupStart);
    if (from < to) sourceIds.push(...group.slice(from, to).map((record) => record.sourceId));
    groupStart += group.length;
    if (groupStart >= end) break;
  }
  return { total, sourceIds };
}
