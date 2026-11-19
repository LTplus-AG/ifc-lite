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
 *   given the merge's one metre unit ({@link MintedRecords}) so every reader agrees.
 * - A context-to-CRS map conversion's Scale carries project-unit distances into map units. Divide it by the
 *   length factor unless keeping it as written preserves the viewer's scale (see {@link viewerAxisScales}).
 *   A CRS-to-CRS conversion keeps its Scale because its source unit is unchanged.
 *
 * IFC2X3 spells the same georeference as the `ePSet_MapConversion` and `ePSet_ProjectedCRS` property sets (#10915),
 * and they follow the same rule: the offset properties are left as written, a CRS set without a MapUnit is given a
 * `METRE` one, and the Scale property is chosen as above. Their values come from the parser's own reading, the one
 * the viewer places the model by, so the plan never reads a property value itself.
 */

import { decodeStepStringLiteral } from '@ifc-lite/encoding';
import { extractGeoreferenceCandidatesOnDemand, type IfcDataStore, type MapConversion, type ProjectedCRS } from '@ifc-lite/parser';
import { COORDINATE_OPERATION_STEP_TYPES, MAP_CONVERSION_STEP_TYPES } from './georef-closure.js';
import { refsIn } from './merged-project-contexts.js';
import { decodeEntity, getStepAttr } from './merged-subcontext.js';
import { slotUnset, stepString } from './schema-converter-structural-source.js';
import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { frameArgs, stepRecordFrame, withFrameArgs } from './step-record-frame.js';
import { computeNormalizeFactor, toStepRealScaled } from './unit-normalize.js';
import { viewerAxisScales } from './viewer-georef-scale.js';

/** Records a merge writes once, at ids past every model's, when a georeference record names them. */
export class MintedRecords {
  private readonly records = new Map<string, { id: number; used: boolean }>();
  constructor(private nextId: number) {}
  /** The output reference of the record `text`, reserved on first ask; it is written only once {@link use}d. */
  refOf(text: string): string {
    if (!this.records.has(text)) this.records.set(text, { id: this.nextId++, used: false });
    return `#${this.records.get(text)!.id}`;
  }
  use(text: string): void { this.records.get(text)!.used = true; }
  /** Appends every used record to `lines`. */
  appendTo(lines: string[]): void {
    for (const [text, { id, used }] of this.records) if (used) lines.push(`#${id}=${text};`);
  }
}

/**
 * How normalize writes one georeference record: as written (no rescale); with argument `attr` set to `value`, which
 * may name the {@link MintedRecords} record `mint`; or with the list at `attr` given a reference to `mint`, in place
 * of its entry `at` or appended.
 */
type GeorefRecord = { kind: 'keep' }
  | { kind: 'edit'; attr: number; value: string; mint?: string }
  | { kind: 'list'; attr: number; mint: string; at?: number };

/** How normalize treats one model's georeference records, by source id. */
export interface GeorefNormalizePlan {
  records: ReadonlyMap<number, GeorefRecord>;
  minted: MintedRecords;
  /** Map conversions (or `ePSet_MapConversion` sets) whose viewer scale no Scale keeps; written with the spec Scale. */
  unkept: readonly number[];
  /** `ePSet_MapConversion` sets whose map unit stays implicit: no ePSet_ProjectedCRS, or no MapUnit normalize could write. */
  implicitUnit: readonly number[];
  /** `ePSet_MapConversion` sets whose Scale normalize could not rewrite, so the viewer shows them at another scale. */
  scaleLeft: readonly number[];
}

/** 0-based index of the CRS's length unit: `IfcProjectedCRS.MapUnit` (IFC4, IFC4X3), `IfcGeographicCRS.HeightUnit`. */
const CRS_UNIT_ATTR = { IFCPROJECTEDCRS: 6, IFCGEOGRAPHICCRS: 5 };
/** 0-based index of `IfcMapConversion.Scale`. */
const SCALE_ATTR = 7;
/** 0-based `IfcPropertySet.Name` and `.HasProperties`, `IfcPropertySingleValue.Name` and `.Unit`. */
const PSET_NAME_ATTR = 2, PSET_PROPERTIES_ATTR = 4, PROPERTY_NAME_ATTR = 0, PROPERTY_UNIT_ATTR = 3;
const METRE_UNIT = 'IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)';
/** The ePSet_MapConversion placement properties, by the names the parser reads (`EPSET_TRANSFORM_PROPERTIES`). */
const EPSET_PLACEMENT = new Set(['Eastings', 'Northings', 'OrthogonalHeight', 'XAxisAbscissa', 'XAxisOrdinate', 'Scale']);

// @raw-entity-enumeration-ok MergeExporter uses a reparsed effective STEP snapshot, so these are the merged input's current records
const idsOf = (dataStore: IfcDataStore, types: Iterable<string>) => [...types].flatMap(type => dataStore.entityIndex.byType.get(type) ?? []);
/** A STEP string slot's decoded text, as the parser decodes it, or '' when it is no string. */
const label = (raw: string | null) => { const text = stepString(raw ?? undefined); return text === null ? '' : decodeStepStringLiteral(text); };
/** The record type of `id`, a deferred property atom included. */
// @raw-entity-enumeration-ok MergeExporter uses a reparsed effective STEP snapshot, so these are the merged input's current records
const typeOf = (dataStore: IfcDataStore, id: number) => (dataStore.entityIndex.byId.get(id) ?? dataStore.deferredEntityIndex?.get(id))?.type?.toUpperCase();

/** The normalize advisory for a model's georeference, or null when it carries none. */
export function georefNormalizeCaveat(name: string, dataStore: IfcDataStore, plan: GeorefNormalizePlan | undefined): string | null {
  if (idsOf(dataStore, COORDINATE_OPERATION_STEP_TYPES).length === 0 && !plan?.records.size && !plan?.implicitUnit.length
    && !plan?.scaleLeft.length) return null;
  const idsIn = (ids: readonly number[]) => `${ids.map(id => `#${id}`).join(', ')} (${ids.length === 1 ? 'an id' : 'ids'} in "${name}")`;
  const unkeptIds = plan?.unkept ?? [], implicitIds = plan?.implicitUnit ?? [], leftIds = plan?.scaleLeft ?? [];
  const unkept = unkeptIds.length === 0 ? '' : unkeptIds.length === 1
    ? ` The viewer cannot show its map conversion ${idsIn(unkeptIds)} at its own scale in the merged unit, so its Scale is written as the IFC specification reads it.`
    : ` The viewer cannot show its map conversions ${idsIn(unkeptIds)} at their own scale in the merged unit, so their Scale is written as the IFC specification reads it.`;
  const implicit = implicitIds.length === 0 ? '' : ` The map unit of ePSet_MapConversion ${idsIn(implicitIds)} stays ` +
    'implicit, with no ePSet_ProjectedCRS or no MapUnit normalize could write; the viewer reads it as metres.';
  const left = leftIds.length === 0 ? '' : ` Normalize could not rewrite the Scale property of ePSet_MapConversion ` +
    `${idsIn(leftIds)}, so the viewer shows it at another scale in the merged unit.`;
  return `Model "${name}" carries georeferencing, whose offsets normalize leaves in the CRS unit (a CRS without one ` +
    `is written in metres). If the model was georeferenced in its own unit, review the merged georeference.${unkept}${implicit}${left}`;
}

/**
 * The Scale that keeps the scale the viewer gives a conversion's geometry once its model is normalized: the divided
 * Scale (the spec reading) as it will be written, else undefined to keep it as written; `unkept` when neither keeps it,
 * and `keepsWritten` when the Scale as written keeps it.
 */
function chooseScale(conversion: Pick<MapConversion, 'scale' | 'factorX' | 'factorY' | 'factorZ'>, mapUnitScale: number | undefined,
  modelScale: number, primaryScale: number): { scale: number | undefined; unkept: boolean; keepsWritten: boolean } {
  const alone = viewerAxisScales(conversion, mapUnitScale, modelScale);
  const keeps = (scale: number | undefined) => viewerAxisScales({ ...conversion, scale }, mapUnitScale, primaryScale)
    .every((value, axis) => Math.abs(value - alone[axis]) <= 1e-9 * Math.abs(alone[axis])); // relative: scales can be tiny
  // As written: a value that rounds to within 1e-9 of 1 reads as unset in the viewer.
  const divided = Number(toStepRealScaled((conversion.scale ?? 1) / computeNormalizeFactor(modelScale, primaryScale)));
  const keepsWritten = keeps(conversion.scale);
  if (keeps(divided)) return { scale: divided, unkept: false, keepsWritten };
  return keepsWritten ? { scale: undefined, unkept: false, keepsWritten } : { scale: divided, unkept: true, keepsWritten };
}

/** The {@link GeorefNormalizePlan} of a model in length unit `modelScale` normalized into `primaryScale`. */
export function planGeorefNormalize(dataStore: IfcDataStore, minted: MintedRecords, modelScale: number, primaryScale: number): GeorefNormalizePlan {
  const records = new Map<number, GeorefRecord>(), unkept: number[] = [], implicitUnit: number[] = [], scaleLeft: number[] = [];
  for (const id of idsOf(dataStore, COORDINATE_OPERATION_STEP_TYPES)) records.set(id, { kind: 'keep' });
  for (const [type, attr] of Object.entries(CRS_UNIT_ATTR)) {
    for (const id of idsOf(dataStore, [type])) {
      if (!slotUnset(getStepAttr(dataStore, id, attr) ?? '$')) continue;
      records.set(id, { kind: 'edit', attr, value: minted.refOf(METRE_UNIT), mint: METRE_UNIT });
    }
  }
  const psets = planEPSets(dataStore);
  const candidates = idsOf(dataStore, MAP_CONVERSION_STEP_TYPES).length || psets.length ? extractGeoreferenceCandidatesOnDemand(dataStore) : null;
  for (const { conversion, targetCRS } of candidates?.mapConversions ?? []) {
    // @raw-entity-enumeration-ok MergeExporter uses a reparsed effective STEP snapshot
    const source = dataStore.entityIndex.byId.get(conversion.sourceCRS);
    if (source?.type !== 'IFCGEOMETRICREPRESENTATIONCONTEXT') continue;
    const choice = chooseScale(conversion, targetCRS?.mapUnitScale, modelScale, primaryScale);
    if (choice.scale !== undefined) records.set(conversion.id, { kind: 'edit', attr: SCALE_ATTR, value: toStepRealScaled(choice.scale) });
    if (choice.unkept) unkept.push(conversion.id);
  }
  // An ePSet_MapConversion's placement properties are left as written: its offsets are in the map unit, and its axis
  // and Scale are ratios. So is a property it cannot read. Any other property of the set is rescaled like any other.
  for (const ids of psets) {
    for (const id of ids) {
      const name = getStepAttr(dataStore, id, PROPERTY_NAME_ATTR);
      if (name === null || EPSET_PLACEMENT.has(label(name))) records.set(id, { kind: 'keep' });
    }
  }
  // The ePSet the viewer reads (when no IFC4 entity places the model) is planned from the parser's reading of it. A
  // placement the parser refused has no conversion and is left as written.
  const epset = candidates?.entities.hasGeoreference ? undefined : candidates?.ePSetMapConversion;
  const plan = { records, minted, unkept, implicitUnit, scaleLeft };
  if (epset?.mapConversion) planViewerEPSet(dataStore, epset.mapConversion, epset.projectedCRS, plan, modelScale, primaryScale);
  return plan;
}

/** The property ids of each of a model's `ePSet_MapConversion` sets (any casing, as the parser finds them). */
function planEPSets(dataStore: IfcDataStore): number[][] {
  // As in the parser's prefilter, a set whose record has neither `epset_` nor a backslash (which may escape part of
  // the name) is passed over before any attribute is parsed.
  return idsOf(dataStore, ['IFCPROPERTYSET']).flatMap(id => {
    if (!/epset_|\\/i.test(decodeEntity(dataStore, id) ?? '')) return [];
    if (label(getStepAttr(dataStore, id, PSET_NAME_ATTR)).toLowerCase() !== 'epset_mapconversion') return [];
    return [refsIn(getStepAttr(dataStore, id, PSET_PROPERTIES_ATTR) ?? '').map(ref => Number(ref.slice(1)))];
  });
}

/**
 * A set's properties with their names and positions in its list, `editable` when a single value without its own
 * Unit; null when the set's property list cannot be read. A property that cannot be read is passed over, as the
 * parser passes it over.
 */
function propertiesOf(dataStore: IfcDataStore, setId: number): Array<{ at: number; name: string; editable: boolean }> | null {
  const list = getStepAttr(dataStore, setId, PSET_PROPERTIES_ATTR);
  if (list === null) return null;
  const properties = [];
  for (const [at, ref] of refsIn(list).entries()) {
    const id = Number(ref.slice(1)), name = getStepAttr(dataStore, id, PROPERTY_NAME_ATTR);
    if (name === null) continue;
    const editable = typeOf(dataStore, id) === 'IFCPROPERTYSINGLEVALUE' && slotUnset(getStepAttr(dataStore, id, PROPERTY_UNIT_ATTR) ?? '$');
    properties.push({ at, name: label(name), editable });
  }
  return properties;
}

/** Plans the ePSet the viewer reads, from the parser's `conversion` and `crs` (whose id is the conversion's own when the model has no ePSet_ProjectedCRS). */
function planViewerEPSet(dataStore: IfcDataStore, conversion: MapConversion, crs: ProjectedCRS | undefined,
  plan: { records: Map<number, GeorefRecord>; minted: MintedRecords; unkept: number[]; implicitUnit: number[]; scaleLeft: number[] },
  modelScale: number, primaryScale: number): void {
  const { records, minted, unkept, implicitUnit, scaleLeft } = plan;
  // Gives the set a new `name` property of `value` in place of the last one so named (the one the parser reads), or
  // appended when it has none. The old record is left as it is, for any other set that lists it too. False when the
  // property is no editable single value, or the set cannot be read, and the set is left as it is.
  const write = (setId: number, name: string, value: string): boolean => {
    const of = propertiesOf(dataStore, setId);
    const last = of?.filter(property => property.name === name).at(-1);
    if (!of || (last !== undefined && !last.editable)) return false;
    const text = `IFCPROPERTYSINGLEVALUE('${name}',$,${value},$)`;
    minted.refOf(text);
    records.set(setId, { kind: 'list', attr: PSET_PROPERTIES_ATTR, mint: text, at: last?.at });
    return true;
  };
  const hasCrsSet = crs !== undefined && crs.id !== conversion.id;
  const unitExplicit = hasCrsSet && (crs.mapUnit !== undefined || write(crs.id, 'MapUnit', "IFCLABEL('METRE')"));
  if (!unitExplicit) implicitUnit.push(conversion.id);
  const choice = chooseScale(conversion, crs?.mapUnitScale, modelScale, primaryScale);
  if (choice.scale === undefined) return;
  if (write(conversion.id, 'Scale', `IFCREAL(${toStepRealScaled(choice.scale)})`)) {
    if (choice.unkept) unkept.push(conversion.id);
  } else if (!choice.keepsWritten) scaleLeft.push(conversion.id);
}

/**
 * A georeference record of a normalized model, in output ids, as the output unit needs it; undefined for any other
 * record, which the caller rescales as usual.
 */
export function normalizeGeorefRecord(text: string, sourceId: number, plan: GeorefNormalizePlan | undefined): string | undefined {
  const record = plan?.records.get(sourceId);
  if (!plan || record === undefined) return undefined;
  if (record.kind === 'keep') return text;
  const { attr, mint } = record;
  return withArgs(text, attr, args => {
    if (record.kind === 'edit') args[attr] = record.value;
    else {
      const refs = refsIn(args[attr]), ref = plan.minted.refOf(record.mint);
      if (record.at === undefined) refs.push(ref);
      else refs[record.at] = ref;
      args[attr] = `(${refs.join(',')})`;
    }
    if (mint !== undefined) plan.minted.use(mint);
  });
}

/** `text` with its arguments edited by `edit`, or unchanged when it has no argument at `index`. */
function withArgs(text: string, index: number, edit: (args: string[]) => void): string {
  const frame = stepRecordFrame(text, { allowMissingSemicolon: true });
  const args = frame && splitTopLevelStepArguments(frameArgs(text, frame));
  if (!frame || !args || args.length <= index) return text;
  edit(args);
  return withFrameArgs(text, frame, args.join(','));
}
