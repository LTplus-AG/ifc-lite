/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Normalize and georeferencing (#10886). A model normalized into the primary's length unit loses its own project
 * unit, so its georeference must not lean on it:
 *
 * - A coordinate operation always targets a CRS (`TargetCRS` is an IfcCoordinateReferenceSystem in IFC4 and IFC4X3),
 *   and its offsets are in that CRS's unit (MapUnit, or HeightUnit for a geographic CRS), so they are left as written.
 * - A CRS with no unit there is read as metres, as the viewer reads it (`@ifc-lite/geo` `map-unit.ts`), and is
 *   given the merge's one {@link MetreUnit} so every reader agrees.
 * - A map conversion's Scale carries project-unit distances into map units, so it is divided by the length factor,
 *   unless keeping it as written is what keeps the scale the viewer gives the model ({@link viewerAxisScales}).
 */

import { extractGeoreferenceCandidatesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { COORDINATE_OPERATION_STEP_TYPES, MAP_CONVERSION_STEP_TYPES } from './georef-closure.js';
import { getStepAttr } from './merged-subcontext.js';
import { slotUnset } from './schema-converter-structural-source.js';
import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { frameArgs, stepRecordFrame, withFrameArgs } from './step-record-frame.js';
import { computeNormalizeFactor, toStepRealScaled } from './unit-normalize.js';
import { viewerAxisScales } from './viewer-georef-scale.js';

/** The metre unit a merge writes once, at output id `id`, when a CRS needed it. */
export interface MetreUnit { id: number; used: boolean }

/** A coordinate operation, with the Scale it is written with when that changes, or a CRS without a unit at `unitAttr`. */
type GeorefRecord = { kind: 'operation'; scale?: number } | { kind: 'unitless'; unitAttr: number };

/** How normalize treats one model's georeference records, by source id. */
export interface GeorefNormalizePlan {
  records: ReadonlyMap<number, GeorefRecord>;
  metre: MetreUnit;
  /** Map conversions whose viewer scale no Scale keeps in the merged unit; written with the divided, spec Scale. */
  unkept: readonly number[];
}

/** 0-based index of the CRS's length unit: `IfcProjectedCRS.MapUnit` (IFC4, IFC4X3), `IfcGeographicCRS.HeightUnit`. */
const CRS_UNIT_ATTR = { IFCPROJECTEDCRS: 6, IFCGEOGRAPHICCRS: 5 };
/** 0-based index of `IfcMapConversion.Scale`. */
const SCALE_ATTR = 7;

// @raw-entity-enumeration-ok MergeExporter uses a reparsed effective STEP snapshot, so these are the merged input's current records
const idsOf = (dataStore: IfcDataStore, types: Iterable<string>) => [...types].flatMap(type => dataStore.entityIndex.byType.get(type) ?? []);

/** The normalize advisory for a model's georeference, or null when it carries none. */
export function georefNormalizeCaveat(name: string, dataStore: IfcDataStore, plan: GeorefNormalizePlan | undefined): string | null {
  if (idsOf(dataStore, COORDINATE_OPERATION_STEP_TYPES).length === 0) return null;
  const unkept = plan?.unkept.length ? ` The viewer cannot show map conversion ${plan.unkept.map(id => `#${id}`).join(', ')} ` +
    'at its own scale in the merged unit, so its Scale is written as the IFC specification reads it.' : '';
  return `Model "${name}" carries georeferencing, whose offsets normalize leaves in the CRS unit (a CRS without one ` +
    `is written in metres). If the model was georeferenced in its own unit, review the merged coordinate operation.${unkept}`;
}

/** The {@link GeorefNormalizePlan} of a model in length unit `modelScale` normalized into `primaryScale`. */
export function planGeorefNormalize(dataStore: IfcDataStore, metre: MetreUnit, modelScale: number, primaryScale: number): GeorefNormalizePlan {
  const records = new Map<number, GeorefRecord>(), unkept: number[] = [];
  for (const id of idsOf(dataStore, COORDINATE_OPERATION_STEP_TYPES)) records.set(id, { kind: 'operation' });
  for (const [type, unitAttr] of Object.entries(CRS_UNIT_ATTR)) {
    for (const id of idsOf(dataStore, [type])) if (slotUnset(getStepAttr(dataStore, id, unitAttr) ?? '$')) records.set(id, { kind: 'unitless', unitAttr });
  }
  // The Scale that keeps the viewer's scale: divided by the length factor (the spec reading), else as written.
  const lengthFactor = computeNormalizeFactor(modelScale, primaryScale);
  const conversions = idsOf(dataStore, MAP_CONVERSION_STEP_TYPES).length ? extractGeoreferenceCandidatesOnDemand(dataStore)?.mapConversions : [];
  for (const { conversion, targetCRS } of conversions ?? []) {
    const alone = viewerAxisScales(conversion, targetCRS?.mapUnitScale, modelScale);
    const keeps = (scale: number | undefined) => viewerAxisScales({ ...conversion, scale }, targetCRS?.mapUnitScale, primaryScale)
      .every((value, axis) => Math.abs(value - alone[axis]) <= 1e-9 * Math.max(1, Math.abs(alone[axis])));
    const divided = (conversion.scale ?? 1) / lengthFactor;
    if (keeps(divided)) records.set(conversion.id, { kind: 'operation', scale: divided });
    else if (!keeps(conversion.scale)) {
      records.set(conversion.id, { kind: 'operation', scale: divided });
      unkept.push(conversion.id);
    }
  }
  return { records, metre, unkept };
}

/**
 * A georeference record of a normalized model, in output ids, as the output unit needs it; undefined for any other
 * record, which the caller rescales as usual.
 */
export function normalizeGeorefRecord(text: string, sourceId: number, plan: GeorefNormalizePlan | undefined): string | undefined {
  const record = plan?.records.get(sourceId);
  if (!plan || record === undefined) return undefined;
  if (record.kind === 'operation') {
    const { scale } = record;
    return scale === undefined ? text : withArgs(text, SCALE_ATTR, args => { args[SCALE_ATTR] = toStepRealScaled(scale); });
  }
  return withArgs(text, record.unitAttr, args => { args[record.unitAttr] = `#${plan.metre.id}`; plan.metre.used = true; });
}

/** Appends the merge's {@link MetreUnit} when a CRS was given it. */
export function appendMetreUnit(lines: string[], metre: MetreUnit): void {
  if (metre.used) lines.push(`#${metre.id}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);
}

/** `text` with its arguments edited by `edit`, or unchanged when it has no argument at `index`. */
function withArgs(text: string, index: number, edit: (args: string[]) => void): string {
  const frame = stepRecordFrame(text, { allowMissingSemicolon: true });
  const args = frame && splitTopLevelStepArguments(frameArgs(text, frame));
  if (!frame || !args || args.length <= index) return text;
  edit(args);
  return withFrameArgs(text, frame, args.join(','));
}
