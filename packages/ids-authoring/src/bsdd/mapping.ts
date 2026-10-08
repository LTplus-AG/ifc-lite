/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bSDD property → IDS property requirement mapping table
 * (05-bsdd.md §2.2, IDS-071).
 *
 * | bSDD | IDS |
 * |---|---|
 * | propertySet | propertySet (absent: the caller's fallback set, declared custom) |
 * | code | baseName (IFC dictionary properties keep their EXPRESS name) |
 * | dataType (+ dimension / unit) | IFC dataType via `BSDD_DATA_TYPES`, refined to a measure |
 * | allowedValues | oneOf over the value codes |
 * | min/max in/exclusive | range (a non-SI unit converted to SI) |
 * | pattern | pattern |
 * | uri | the requirement's @uri |
 * | isRequired | required / optional |
 *
 * bSDD data quality varies, so the table maps conservatively: anything it
 * cannot map faithfully is left out and reported as a note (an unknown
 * data type → no dataType, which lint IDSL-PROP-003 then flags), never
 * guessed. Pure: no schema tables, no network.
 */

import type { RequirementOptionality } from '@ifc-lite/ids';
import type { BsddPropertySelection, BsddPropertySnapshot, ConstraintDraft, FacetDraft, XsdBase } from '../ops/types.js';
import { isKnownUnit, toSI } from '../ops/units.js';

export interface BsddDataTypeRule {
  /** IFC data type for the bSDD data type when nothing refines it. */
  ifc: string;
  /** XSD base of value restrictions. */
  base: XsdBase;
  /** Whether a dimension or unit refines it to a measure. */
  measured: boolean;
}

/** bSDD data type (lower case) → IFC data type. */
export const BSDD_DATA_TYPES: Readonly<Record<string, BsddDataTypeRule>> = {
  boolean: { ifc: 'IFCBOOLEAN', base: 'xs:boolean', measured: false },
  character: { ifc: 'IFCLABEL', base: 'xs:string', measured: false },
  string: { ifc: 'IFCLABEL', base: 'xs:string', measured: false },
  integer: { ifc: 'IFCINTEGER', base: 'xs:integer', measured: false },
  real: { ifc: 'IFCREAL', base: 'xs:double', measured: true },
  time: { ifc: 'IFCDATETIME', base: 'xs:dateTime', measured: false },
};

/** SI dimension exponents `L M T I Θ N J` → IFC measure. */
export const DIMENSION_MEASURES: Readonly<Record<string, string>> = {
  '1 0 0 0 0 0 0': 'IFCLENGTHMEASURE',
  '2 0 0 0 0 0 0': 'IFCAREAMEASURE',
  '3 0 0 0 0 0 0': 'IFCVOLUMEMEASURE',
  '0 1 0 0 0 0 0': 'IFCMASSMEASURE',
  '0 0 1 0 0 0 0': 'IFCTIMEMEASURE',
  '0 0 0 1 0 0 0': 'IFCELECTRICCURRENTMEASURE',
  '0 0 0 0 1 0 0': 'IFCTHERMODYNAMICTEMPERATUREMEASURE',
  '1 1 -2 0 0 0 0': 'IFCFORCEMEASURE',
  '-1 1 -2 0 0 0 0': 'IFCPRESSUREMEASURE',
  '2 1 -2 0 0 0 0': 'IFCENERGYMEASURE',
  '2 1 -3 0 0 0 0': 'IFCPOWERMEASURE',
  '2 1 -3 -1 0 0 0': 'IFCELECTRICVOLTAGEMEASURE',
  '0 0 -1 0 0 0 0': 'IFCFREQUENCYMEASURE',
  '1 0 -1 0 0 0 0': 'IFCLINEARVELOCITYMEASURE',
  '3 0 -1 0 0 0 0': 'IFCVOLUMETRICFLOWRATEMEASURE',
  '-3 1 0 0 0 0 0': 'IFCMASSDENSITYMEASURE',
  '0 1 -3 0 -1 0 0': 'IFCTHERMALTRANSMITTANCEMEASURE',
  '1 1 -3 0 -1 0 0': 'IFCTHERMALCONDUCTIVITYMEASURE',
};

/** Unit symbol (lower case) → IFC measure, for properties published without a dimension. */
export const UNIT_MEASURES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(['mm', 'cm', 'dm', 'm', 'km', 'in', 'ft'].map((u) => [u, 'IFCLENGTHMEASURE'])),
  ...Object.fromEntries(['mm2', 'cm2', 'm2', 'mm²', 'cm²', 'm²', 'ft2', 'ft²'].map((u) => [u, 'IFCAREAMEASURE'])),
  ...Object.fromEntries(['mm3', 'cm3', 'm3', 'mm³', 'cm³', 'm³', 'l'].map((u) => [u, 'IFCVOLUMEMEASURE'])),
  ...Object.fromEntries(['g', 'kg', 't'].map((u) => [u, 'IFCMASSMEASURE'])),
  ...Object.fromEntries(['s', 'min', 'h'].map((u) => [u, 'IFCTIMEMEASURE'])),
  ...Object.fromEntries(['k', '°c', 'degc'].map((u) => [u, 'IFCTHERMODYNAMICTEMPERATUREMEASURE'])),
  ...Object.fromEntries(['n', 'kn'].map((u) => [u, 'IFCFORCEMEASURE'])),
  ...Object.fromEntries(['pa', 'kpa', 'mpa'].map((u) => [u, 'IFCPRESSUREMEASURE'])),
  ...Object.fromEntries(['rad', 'deg', '°'].map((u) => [u, 'IFCPLANEANGLEMEASURE'])),
  j: 'IFCENERGYMEASURE',
  w: 'IFCPOWERMEASURE',
  hz: 'IFCFREQUENCYMEASURE',
  'm/s': 'IFCLINEARVELOCITYMEASURE',
  'kg/m3': 'IFCMASSDENSITYMEASURE',
  'kg/m³': 'IFCMASSDENSITYMEASURE',
  ...Object.fromEntries(['w/(m2·k)', 'w/(m²·k)', 'w/(m2k)', 'w/m2k'].map((u) => [u, 'IFCTHERMALTRANSMITTANCEMEASURE'])),
  ...Object.fromEntries(['w/(m·k)', 'w/(mk)', 'w/mk'].map((u) => [u, 'IFCTHERMALCONDUCTIVITYMEASURE'])),
};

/** Units whose values are already SI (no conversion, no note). */
const SI_UNITS = new Set(['m', 'm2', 'm²', 'm3', 'm³', 'kg', 's', 'k', 'n', 'pa', 'rad', 'j', 'w', 'hz', 'm/s', 'kg/m3', 'kg/m³', 'w/(m2·k)', 'w/(m²·k)', 'w/(m2k)', 'w/m2k', 'w/(m·k)', 'w/(mk)', 'w/mk']);

export type BsddMappingNoteCode =
  | 'unknown-data-type'
  | 'no-data-type'
  | 'standard-data-type'
  | 'unit-converted'
  | 'unit-unknown'
  | 'value-not-mapped'
  | 'values-over-range'
  | 'fallback-property-set';

export interface BsddMappingNote {
  code: BsddMappingNoteCode;
  message: string;
}

export interface BsddPropertyMapping {
  facet: Extract<FacetDraft, { type: 'property' }>;
  optionality: RequirementOptionality;
  propertySet: string;
  baseName: string;
  /** IFC data type written, when one was mapped. */
  dataType?: string;
  notes: BsddMappingNote[];
}

/** A property the table cannot place (no property set and no fallback). */
export class BsddMappingError extends Error {
  constructor(readonly property: string, message: string) {
    super(message);
    this.name = 'BsddMappingError';
  }
}

function normDimension(d: string | undefined): string | undefined {
  if (!d) return undefined;
  const parts = d.trim().split(/[\s,]+/).map(Number);
  return parts.length === 7 && parts.every(Number.isFinite) ? parts.join(' ') : undefined;
}

/** The IFC data type of a bSDD property, refined by dimension, then unit. */
export function mapBsddDataType(p: Pick<BsddPropertySnapshot, 'dataType' | 'dimension' | 'units'>): string | undefined {
  const rule = p.dataType ? BSDD_DATA_TYPES[p.dataType.trim().toLowerCase()] : undefined;
  if (!rule) return undefined;
  if (!rule.measured) return rule.ifc;
  const byDimension = DIMENSION_MEASURES[normDimension(p.dimension) ?? ''];
  if (byDimension) return byDimension;
  const unit = p.units?.[0]?.trim().toLowerCase();
  return (unit && UNIT_MEASURES[unit]) || rule.ifc;
}

function rangeDraft(p: BsddPropertySnapshot, base: XsdBase, notes: BsddMappingNote[]): ConstraintDraft | undefined {
  const min = p.minInclusive ?? p.minExclusive;
  const max = p.maxInclusive ?? p.maxExclusive;
  if (min === undefined && max === undefined) return undefined;
  const draft: Extract<ConstraintDraft, { kind: 'range' }> = { kind: 'range', base };
  if (min !== undefined) Object.assign(draft, { min, minInclusive: p.minInclusive !== undefined });
  if (max !== undefined) Object.assign(draft, { max, maxInclusive: p.maxInclusive !== undefined });
  const unit = p.units?.[0]?.trim();
  if (!unit || SI_UNITS.has(unit.toLowerCase())) return draft;
  if (isKnownUnit(unit)) {
    const shown = [min, max].filter((v): v is number => v !== undefined).map((v) => `${v} ${unit} → ${toSI(v, unit)}`);
    notes.push({ code: 'unit-converted', message: `${p.code}: bounds converted to SI (${shown.join(', ')})` });
    return { ...draft, unit };
  }
  notes.push({ code: 'unit-unknown', message: `${p.code}: unit "${unit}" is not known; bounds kept as published, check that they are SI` });
  return draft;
}

function valueDraft(p: BsddPropertySnapshot, rule: BsddDataTypeRule | undefined, notes: BsddMappingNote[]): ConstraintDraft | undefined {
  const kind = p.propertyValueKind?.trim().toLowerCase();
  if (kind && kind !== 'single') {
    notes.push({ code: 'value-not-mapped', message: `${p.code}: a ${p.propertyValueKind} value has no IDS restriction; only presence is required` });
    return undefined;
  }
  const base = rule?.base ?? 'xs:string';
  const hasRange = [p.minInclusive, p.maxInclusive, p.minExclusive, p.maxExclusive].some((v) => v !== undefined);
  if (p.allowedValues?.length && rule?.base !== 'xs:boolean') {
    if (hasRange || p.pattern) notes.push({ code: 'values-over-range', message: `${p.code}: allowed values used; the published range/pattern is not added` });
    return { kind: 'oneOf', values: p.allowedValues.map((v) => v.code), base };
  }
  if (hasRange && (base === 'xs:double' || base === 'xs:integer')) return rangeDraft(p, base, notes);
  if (p.pattern) return { kind: 'pattern', pattern: p.pattern, base: 'xs:string' };
  return undefined;
}

/** Map one bSDD property to an IDS property requirement. Throws `BsddMappingError` when it has no property set. */
export function mapBsddProperty(p: BsddPropertySnapshot, options: Omit<BsddPropertySelection, 'select'> = {}): BsddPropertyMapping {
  const notes: BsddMappingNote[] = [];
  let pset = p.propertySet;
  if (!pset) {
    if (!options.fallbackPropertySet) throw new BsddMappingError(p.code, `bSDD property ${p.code} has no property set; choose one`);
    pset = options.fallbackPropertySet;
    notes.push({ code: 'fallback-property-set', message: `${p.code}: no property set in bSDD; placed in ${pset}` });
  }
  const rule = p.dataType ? BSDD_DATA_TYPES[p.dataType.trim().toLowerCase()] : undefined;
  let dataType = mapBsddDataType(p);
  if (p.standardDataType) {
    dataType = p.standardDataType.toUpperCase();
    notes.push({ code: 'standard-data-type', message: `${p.code}: data type taken from the standard property (${dataType})` });
  } else if (p.dataType && !rule) {
    notes.push({ code: 'unknown-data-type', message: `${p.code}: bSDD data type "${p.dataType}" has no IFC mapping; no dataType written` });
  } else if (!p.dataType) {
    notes.push({ code: 'no-data-type', message: `${p.code}: bSDD publishes no data type; no dataType written` });
  }
  const facet: BsddPropertyMapping['facet'] = { type: 'property', propertySet: { kind: 'equals', value: pset }, baseName: { kind: 'equals', value: p.code } };
  if (dataType) facet.dataType = { kind: 'equals', value: dataType };
  const value = valueDraft(p, rule, notes);
  if (value) facet.value = value;
  if (p.uri && options.uri !== false) facet.uri = p.uri;
  const policy = options.optionality ?? 'fromClass';
  const optionality: RequirementOptionality = policy === 'fromClass' ? (p.isRequired ? 'required' : 'optional') : policy;
  if (optionality === 'optional' && !dataType) {
    // IDS 1.0 (and the buildingSMART audit): an optional property requirement must name its dataType.
    throw new BsddMappingError(p.code, `bSDD property ${p.code}: an optional requirement needs a dataType in IDS 1.0 and none maps; require it or leave it out`);
  }
  return { facet, optionality, propertySet: pset, baseName: p.code, ...(dataType ? { dataType } : {}), notes };
}
