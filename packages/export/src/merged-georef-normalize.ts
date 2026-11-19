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
 * `METRE` one, and the Scale property is chosen as above.
 */

import { isCompleteStepNumericLiteral } from '@ifc-lite/data';
import { decodeStepStringLiteral } from '@ifc-lite/encoding';
import { extractGeoreferenceCandidatesOnDemand, type IfcDataStore, type MapConversion } from '@ifc-lite/parser';
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
 * may name the {@link MintedRecords} record `mint`; or with the list at `attr` given a reference to `mint`.
 */
type GeorefRecord = { kind: 'keep' }
  | { kind: 'edit'; attr: number; value: string; mint?: string }
  | { kind: 'append'; attr: number; mint: string };

/** How normalize treats one model's georeference records, by source id. */
export interface GeorefNormalizePlan {
  records: ReadonlyMap<number, GeorefRecord>;
  minted: MintedRecords;
  /** Map conversions (or `ePSet_MapConversion` sets) whose viewer scale no Scale keeps; written with the spec Scale. */
  unkept: readonly number[];
  /** `ePSet_MapConversion` sets of a model with no `ePSet_ProjectedCRS`, whose map unit stays implicit. */
  implicitUnit: readonly number[];
}

/** 0-based index of the CRS's length unit: `IfcProjectedCRS.MapUnit` (IFC4, IFC4X3), `IfcGeographicCRS.HeightUnit`. */
const CRS_UNIT_ATTR = { IFCPROJECTEDCRS: 6, IFCGEOGRAPHICCRS: 5 };
/** 0-based index of `IfcMapConversion.Scale`. */
const SCALE_ATTR = 7;
/** 0-based `IfcPropertySet.Name` and `.HasProperties`, `IfcPropertySingleValue.Name` and `.NominalValue`. */
const PSET_NAME_ATTR = 2, PSET_PROPERTIES_ATTR = 4, PROPERTY_NAME_ATTR = 0, PROPERTY_VALUE_ATTR = 2;
const METRE_UNIT = 'IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)';
/** The ePSet properties normalize leaves as written, by the exact name the parser reads (`georef-epset.ts`). */
const EPSET_OFFSETS = new Set(['Eastings', 'Northings', 'OrthogonalHeight']);

// @raw-entity-enumeration-ok MergeExporter uses a reparsed effective STEP snapshot, so these are the merged input's current records
const idsOf = (dataStore: IfcDataStore, types: Iterable<string>) => [...types].flatMap(type => dataStore.entityIndex.byType.get(type) ?? []);
/** A STEP string slot's decoded text, as the parser decodes it, or '' when it is no string. */
const label = (raw: string | null) => { const text = stepString(raw ?? undefined); return text === null ? '' : decodeStepStringLiteral(text); };
/**
 * A property's NominalValue as a number the way the parser reads it (`getNumber`): the whole typed or string value
 * must be a numeric literal, so `IFCLABEL('0.5x')` is no number.
 */
function nominalNumber(raw: string | null): number | undefined {
  // STEP comments may sit inside the value, as the parser allows: `IFCREAL(0.9996 /* scale */)`.
  const bare = (raw ?? '').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const inner = bare.match(/^\s*\w+\s*\(([\s\S]*)\)\s*$/)?.[1] ?? bare;
  const literal = (stepString(inner) ?? inner).trim();
  return isCompleteStepNumericLiteral(literal) && Number.isFinite(Number(literal)) ? Number(literal) : undefined;
}

/** The normalize advisory for a model's georeference, or null when it carries none. */
export function georefNormalizeCaveat(name: string, dataStore: IfcDataStore, plan: GeorefNormalizePlan | undefined): string | null {
  if (idsOf(dataStore, COORDINATE_OPERATION_STEP_TYPES).length === 0 && !plan?.records.size) return null;
  const idsIn = (ids: readonly number[]) => `${ids.map(id => `#${id}`).join(', ')} (${ids.length === 1 ? 'an id' : 'ids'} in "${name}")`;
  const unkeptIds = plan?.unkept ?? [], implicitIds = plan?.implicitUnit ?? [];
  const unkept = unkeptIds.length === 0 ? '' : unkeptIds.length === 1
    ? ` The viewer cannot show its map conversion ${idsIn(unkeptIds)} at its own scale in the merged unit, so its Scale is written as the IFC specification reads it.`
    : ` The viewer cannot show its map conversions ${idsIn(unkeptIds)} at their own scale in the merged unit, so their Scale is written as the IFC specification reads it.`;
  const implicit = implicitIds.length === 0 ? '' : ` It has no ePSet_ProjectedCRS, so the map unit of ePSet_MapConversion ` +
    `${idsIn(implicitIds)} stays implicit; the viewer reads it as metres.`;
  return `Model "${name}" carries georeferencing, whose offsets normalize leaves in the CRS unit (a CRS without one ` +
    `is written in metres). If the model was georeferenced in its own unit, review the merged georeference.${unkept}${implicit}`;
}

/**
 * The Scale that keeps the scale the viewer gives a conversion's geometry once its model is normalized: the divided
 * Scale (the spec reading) as it will be written, else undefined to keep it as written; `unkept` when neither keeps it.
 */
function chooseScale(conversion: Pick<MapConversion, 'scale' | 'factorX' | 'factorY' | 'factorZ'>, mapUnitScale: number | undefined,
  modelScale: number, primaryScale: number): { scale: number | undefined; unkept: boolean } {
  const alone = viewerAxisScales(conversion, mapUnitScale, modelScale);
  const keeps = (scale: number | undefined) => viewerAxisScales({ ...conversion, scale }, mapUnitScale, primaryScale)
    .every((value, axis) => Math.abs(value - alone[axis]) <= 1e-9 * Math.abs(alone[axis])); // relative: scales can be tiny
  // As written: a value that rounds to within 1e-9 of 1 reads as unset in the viewer.
  const divided = Number(toStepRealScaled((conversion.scale ?? 1) / computeNormalizeFactor(modelScale, primaryScale)));
  if (keeps(divided)) return { scale: divided, unkept: false };
  return keeps(conversion.scale) ? { scale: undefined, unkept: false } : { scale: divided, unkept: true };
}

/** The {@link GeorefNormalizePlan} of a model in length unit `modelScale` normalized into `primaryScale`. */
export function planGeorefNormalize(dataStore: IfcDataStore, minted: MintedRecords, modelScale: number, primaryScale: number): GeorefNormalizePlan {
  const records = new Map<number, GeorefRecord>(), unkept: number[] = [], implicitUnit: number[] = [];
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
  // The ePSet sets, read as the viewer reads them: the first ePSet_ProjectedCRS gives the map unit.
  const hasCrsSet = psets.some(({ kind }) => kind === 'epset_projectedcrs');
  const mapUnitScale = candidates?.ePSetMapConversion?.projectedCRS?.mapUnitScale;
  for (const { id, kind, properties } of psets) {
    const append = (text: string) => { minted.refOf(text); records.set(id, { kind: 'append', attr: PSET_PROPERTIES_ATTR, mint: text }); };
    if (kind === 'epset_projectedcrs') {
      const unit = properties.get('MapUnit');
      const metreLabel = "IFCLABEL('METRE')";
      if (unit === undefined) append(`IFCPROPERTYSINGLEVALUE('MapUnit',$,${metreLabel},$)`);
      else if (slotUnset(getStepAttr(dataStore, unit, PROPERTY_VALUE_ATTR) ?? '$')) {
        records.set(unit, { kind: 'edit', attr: PROPERTY_VALUE_ATTR, value: metreLabel });
      }
      continue;
    }
    if (!hasCrsSet) implicitUnit.push(id);
    for (const [name, property] of properties) if (EPSET_OFFSETS.has(name)) records.set(property, { kind: 'keep' });
    const scaleProperty = properties.get('Scale');
    const written = scaleProperty === undefined ? undefined : nominalNumber(getStepAttr(dataStore, scaleProperty, PROPERTY_VALUE_ATTR));
    const choice = chooseScale({ scale: written }, mapUnitScale, modelScale, primaryScale);
    if (choice.unkept) unkept.push(id);
    if (choice.scale === undefined) continue;
    const value = `IFCREAL(${toStepRealScaled(choice.scale)})`;
    if (scaleProperty === undefined) append(`IFCPROPERTYSINGLEVALUE('Scale',$,${value},$)`);
    else records.set(scaleProperty, { kind: 'edit', attr: PROPERTY_VALUE_ATTR, value });
  }
  return { records, minted, unkept, implicitUnit };
}

/**
 * A model's `ePSet_MapConversion` and `ePSet_ProjectedCRS` sets (any casing, as the parser finds them), with their
 * properties by name. As in the parser's prefilter, a set whose record has neither `epset_` nor a backslash (which
 * may escape part of the name) is passed over before any attribute is parsed.
 */
function planEPSets(dataStore: IfcDataStore) {
  return idsOf(dataStore, ['IFCPROPERTYSET']).flatMap(id => {
    if (!/epset_|\\/i.test(decodeEntity(dataStore, id) ?? '')) return [];
    const kind = label(getStepAttr(dataStore, id, PSET_NAME_ATTR)).toLowerCase();
    if (kind !== 'epset_mapconversion' && kind !== 'epset_projectedcrs') return [];
    const properties = new Map(refsIn(getStepAttr(dataStore, id, PSET_PROPERTIES_ATTR) ?? '')
      .map(ref => Number(ref.slice(1)))
      .map(property => [label(getStepAttr(dataStore, property, PROPERTY_NAME_ATTR)), property] as const));
    return [{ id, kind, properties }];
  });
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
    const list = args[attr].trim();
    args[attr] = record.kind === 'edit' ? record.value : `(${[...refsIn(list), plan.minted.refOf(record.mint)].join(',')})`;
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
