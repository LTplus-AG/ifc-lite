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

import { extractGeoreferenceCandidatesOnDemand, type IfcDataStore, type MapConversion } from '@ifc-lite/parser';
import { COORDINATE_OPERATION_STEP_TYPES, MAP_CONVERSION_STEP_TYPES } from './georef-closure.js';
import { refsIn } from './merged-project-contexts.js';
import { getStepAttr } from './merged-subcontext.js';
import { slotUnset } from './schema-converter-structural-source.js';
import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { frameArgs, stepRecordFrame, withFrameArgs } from './step-record-frame.js';
import { computeNormalizeFactor, toStepRealScaled } from './unit-normalize.js';
import { viewerAxisScales } from './viewer-georef-scale.js';

/** Records a merge writes once, at ids past every model's, when a georeference record names them. */
export class MintedRecords {
  private readonly ids = new Map<string, number>();
  private readonly used = new Set<string>();
  constructor(private nextId: number) {}
  /** The output id of the record `text`, reserved on first ask; it is written only once {@link use}d. */
  idOf(text: string): number {
    if (!this.ids.has(text)) this.ids.set(text, this.nextId++);
    return this.ids.get(text)!;
  }
  use(text: string): void { this.used.add(text); }
  /** Appends every used record to `lines`. */
  appendTo(lines: string[]): void {
    for (const [text, id] of this.ids) if (this.used.has(text)) lines.push(`#${id}=${text};`);
  }
}

/**
 * How normalize writes one georeference record: as written (no rescale), or with argument `attr` replaced by `value`
 * or, for a list, given `append` (output references); `mints` are the {@link MintedRecords} the edit names.
 */
type GeorefRecord = { kind: 'keep' } | { kind: 'edit'; attr: number; value?: string; append?: string[]; mints?: string[] };

/** How normalize treats one model's georeference records, by source id. */
export interface GeorefNormalizePlan {
  records: ReadonlyMap<number, GeorefRecord>;
  minted: MintedRecords;
  /** Map conversions (or `ePSet_MapConversion` sets) whose viewer scale no Scale keeps; written with the spec Scale. */
  unkept: readonly number[];
}

/** 0-based index of the CRS's length unit: `IfcProjectedCRS.MapUnit` (IFC4, IFC4X3), `IfcGeographicCRS.HeightUnit`. */
const CRS_UNIT_ATTR = { IFCPROJECTEDCRS: 6, IFCGEOGRAPHICCRS: 5 };
/** 0-based index of `IfcMapConversion.Scale`. */
const SCALE_ATTR = 7;
/** 0-based `IfcPropertySet.HasProperties` and `IfcPropertySingleValue.NominalValue`. */
const PSET_PROPERTIES_ATTR = 4, PROPERTY_VALUE_ATTR = 2;
const METRE_UNIT = 'IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)';
const EPSET_OFFSETS = new Set(['eastings', 'northings', 'orthogonalheight']);

// @raw-entity-enumeration-ok MergeExporter uses a reparsed effective STEP snapshot, so these are the merged input's current records
const idsOf = (dataStore: IfcDataStore, types: Iterable<string>) => [...types].flatMap(type => dataStore.entityIndex.byType.get(type) ?? []);
/** A STEP string slot's text, lower-cased, or '' when it is no string. */
const label = (raw: string | null) => raw?.match(/^'(.*)'$/s)?.[1].toLowerCase() ?? '';

/** The normalize advisory for a model's georeference, or null when it carries none. */
export function georefNormalizeCaveat(name: string, dataStore: IfcDataStore, plan: GeorefNormalizePlan | undefined): string | null {
  if (idsOf(dataStore, COORDINATE_OPERATION_STEP_TYPES).length === 0 && !plan?.records.size) return null;
  const unkeptIds = plan?.unkept ?? [], ids = unkeptIds.map(id => `#${id}`).join(', ');
  const unkept = unkeptIds.length === 0 ? '' : unkeptIds.length === 1
    ? ` The viewer cannot show its map conversion ${ids} (an id in "${name}") at its own scale in the merged unit, so its Scale is written as the IFC specification reads it.`
    : ` The viewer cannot show its map conversions ${ids} (ids in "${name}") at their own scale in the merged unit, so their Scale is written as the IFC specification reads it.`;
  return `Model "${name}" carries georeferencing, whose offsets normalize leaves in the CRS unit (a CRS without one ` +
    `is written in metres). If the model was georeferenced in its own unit, review the merged coordinate operation.${unkept}`;
}

/**
 * The Scale that keeps the scale the viewer gives a conversion's geometry once its model is normalized: the divided
 * Scale (the spec reading) as it will be written, else undefined to keep it as written; `unkept` when neither keeps it.
 */
function chooseScale(conversion: Pick<MapConversion, 'scale' | 'factorX' | 'factorY' | 'factorZ'>, mapUnitScale: number | undefined,
  modelScale: number, primaryScale: number): { scale?: number; unkept?: true } {
  const alone = viewerAxisScales(conversion, mapUnitScale, modelScale);
  const keeps = (scale: number | undefined) => viewerAxisScales({ ...conversion, scale }, mapUnitScale, primaryScale)
    .every((value, axis) => Math.abs(value - alone[axis]) <= 1e-9 * Math.abs(alone[axis])); // relative: scales can be tiny
  // As written: a value that rounds to within 1e-9 of 1 reads as unset in the viewer.
  const divided = Number(toStepRealScaled((conversion.scale ?? 1) / computeNormalizeFactor(modelScale, primaryScale)));
  if (keeps(divided)) return { scale: divided };
  return keeps(conversion.scale) ? {} : { scale: divided, unkept: true };
}

/** The {@link GeorefNormalizePlan} of a model in length unit `modelScale` normalized into `primaryScale`. */
export function planGeorefNormalize(dataStore: IfcDataStore, minted: MintedRecords, modelScale: number, primaryScale: number): GeorefNormalizePlan {
  const records = new Map<number, GeorefRecord>(), unkept: number[] = [];
  for (const id of idsOf(dataStore, COORDINATE_OPERATION_STEP_TYPES)) records.set(id, { kind: 'keep' });
  for (const [type, attr] of Object.entries(CRS_UNIT_ATTR)) {
    for (const id of idsOf(dataStore, [type])) {
      if (!slotUnset(getStepAttr(dataStore, id, attr) ?? '$')) continue;
      records.set(id, { kind: 'edit', attr, value: `#${minted.idOf(METRE_UNIT)}`, mints: [METRE_UNIT] });
    }
  }
  const psets = planEPSets(dataStore);
  const candidates = idsOf(dataStore, MAP_CONVERSION_STEP_TYPES).length || psets.length ? extractGeoreferenceCandidatesOnDemand(dataStore) : null;
  for (const { conversion, targetCRS } of candidates?.mapConversions ?? []) {
    // @raw-entity-enumeration-ok MergeExporter uses a reparsed effective STEP snapshot
    const source = dataStore.entityIndex.byId.get(conversion.sourceCRS);
    if (source?.type !== 'IFCGEOMETRICREPRESENTATIONCONTEXT') continue;
    const { scale, unkept: none } = chooseScale(conversion, targetCRS?.mapUnitScale, modelScale, primaryScale);
    if (scale !== undefined) records.set(conversion.id, { kind: 'edit', attr: SCALE_ATTR, value: toStepRealScaled(scale) });
    if (none) unkept.push(conversion.id);
  }
  // The ePSet sets, read as the viewer reads them: the first ePSet_ProjectedCRS gives the map unit.
  const mapUnitScale = candidates?.ePSetMapConversion?.projectedCRS?.mapUnitScale;
  for (const { id, kind, properties } of psets) {
    const append = (text: string) => records.set(id, { kind: 'edit', attr: PSET_PROPERTIES_ATTR, append: [`#${minted.idOf(text)}`], mints: [text] });
    if (kind === 'epset_projectedcrs') {
      const unit = properties.get('mapunit');
      const metreLabel = "IFCLABEL('METRE')";
      if (unit === undefined) append(`IFCPROPERTYSINGLEVALUE('MapUnit',$,${metreLabel},$)`);
      else if (slotUnset(getStepAttr(dataStore, unit, PROPERTY_VALUE_ATTR) ?? '$')) {
        records.set(unit, { kind: 'edit', attr: PROPERTY_VALUE_ATTR, value: metreLabel });
      }
      continue;
    }
    for (const [name, property] of properties) if (EPSET_OFFSETS.has(name)) records.set(property, { kind: 'keep' });
    const scaleProperty = properties.get('scale');
    // The written Scale, bare or typed (`IFCREAL(0.001)`); unset when absent or `$`.
    const raw = scaleProperty === undefined ? null : getStepAttr(dataStore, scaleProperty, PROPERTY_VALUE_ATTR);
    const written = Number(raw?.match(/^(?:\w+\s*\(\s*)?([-+.\dEe]+)/)?.[1] ?? NaN);
    const { scale, unkept: none } = chooseScale({ scale: Number.isFinite(written) ? written : undefined }, mapUnitScale, modelScale, primaryScale);
    if (none) unkept.push(id);
    if (scale === undefined) continue;
    const value = `IFCREAL(${toStepRealScaled(scale)})`;
    if (scaleProperty === undefined) append(`IFCPROPERTYSINGLEVALUE('Scale',$,${value},$)`);
    else records.set(scaleProperty, { kind: 'edit', attr: PROPERTY_VALUE_ATTR, value });
  }
  return { records, minted, unkept };
}

/** A model's `ePSet_MapConversion` and `ePSet_ProjectedCRS` sets, with their properties by lower-cased name. */
function planEPSets(dataStore: IfcDataStore) {
  return idsOf(dataStore, ['IFCPROPERTYSET']).flatMap(id => {
    const kind = label(getStepAttr(dataStore, id, 2));
    if (kind !== 'epset_mapconversion' && kind !== 'epset_projectedcrs') return [];
    const properties = new Map(refsIn(getStepAttr(dataStore, id, PSET_PROPERTIES_ATTR) ?? '')
      .map(ref => Number(ref.slice(1)))
      .map(property => [label(getStepAttr(dataStore, property, 0)), property] as const));
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
  const { attr, value, append = [], mints = [] } = record;
  return withArgs(text, attr, args => {
    const list = args[attr].trim();
    args[attr] = value ?? `${list.slice(0, list.lastIndexOf(')'))}${list.length > 2 ? ',' : ''}${append.join(',')})`;
    for (const mint of mints) plan.minted.use(mint);
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
