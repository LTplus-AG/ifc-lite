/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Normalize and georeferencing (#10886). A model normalized into the primary's length unit loses its own project
 * unit, so its georeference must not lean on it:
 *
 * - A coordinate operation always targets a CRS (`TargetCRS` is an IfcCoordinateReferenceSystem in IFC4 and IFC4X3),
 *   and its values are in that CRS's unit (MapUnit, or HeightUnit for a geographic CRS), so it is left as written.
 * - A CRS with no unit there is read as metres, as the viewer reads it (`@ifc-lite/geo` `map-unit.ts`), and is
 *   given the merge's one {@link MetreUnit} so every reader agrees.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { COORDINATE_OPERATION_STEP_TYPES } from './georef-closure.js';
import { CRS_TYPES } from './merged-context.js';
import { getStepAttr } from './merged-subcontext.js';
import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { frameArgs, stepRecordFrame, withFrameArgs } from './step-record-frame.js';

/** The metre unit a merge writes once, at output id `id`, when a CRS needed it. */
export interface MetreUnit { id: number; used: boolean }

/** How normalize treats one model's georeference records, by source id. */
export interface GeorefNormalizePlan {
  /** Coordinate operations, left as written, and CRSs with no unit at {@link CRS_UNIT_ATTR}, given {@link metre}. */
  records: ReadonlyMap<number, 'operation' | 'unitless'>;
  metre: MetreUnit;
}

/** 0-based index of `IfcProjectedCRS.MapUnit` and `IfcGeographicCRS.HeightUnit` (IFC4, IFC4X3). */
const CRS_UNIT_ATTR = 6;

/** The {@link GeorefNormalizePlan} of a model being normalized. */
export function planGeorefNormalize(dataStore: IfcDataStore, metre: MetreUnit): GeorefNormalizePlan {
  // @raw-entity-enumeration-ok MergeExporter uses a reparsed effective STEP snapshot, so these are the merged input's current records
  const { byType } = dataStore.entityIndex;
  const records = new Map<number, 'operation' | 'unitless'>();
  for (const id of COORDINATE_OPERATION_STEP_TYPES.flatMap(type => byType.get(type) ?? [])) records.set(id, 'operation');
  for (const id of [...CRS_TYPES].flatMap(type => byType.get(type) ?? [])) {
    if ((getStepAttr(dataStore, id, CRS_UNIT_ATTR) ?? '$') === '$') records.set(id, 'unitless');
  }
  return { records, metre };
}

/**
 * A georeference record of a normalized model, in output ids, as the output unit needs it; undefined for any other
 * record, which the caller rescales as usual.
 */
export function normalizeGeorefRecord(text: string, sourceId: number, plan: GeorefNormalizePlan | undefined): string | undefined {
  const kind = plan?.records.get(sourceId);
  if (!plan || kind === undefined) return undefined;
  if (kind === 'operation') return text;
  const frame = stepRecordFrame(text, { allowMissingSemicolon: true });
  const args = frame && splitTopLevelStepArguments(frameArgs(text, frame));
  if (!frame || !args || args.length <= CRS_UNIT_ATTR) return text;
  args[CRS_UNIT_ATTR] = `#${plan.metre.id}`;
  plan.metre.used = true;
  return withFrameArgs(text, frame, args.join(','));
}

/** Appends the merge's {@link MetreUnit} when a CRS was given it. */
export function appendMetreUnit(lines: string[], metre: MetreUnit): void {
  if (metre.used) lines.push(`#${metre.id}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);
}
