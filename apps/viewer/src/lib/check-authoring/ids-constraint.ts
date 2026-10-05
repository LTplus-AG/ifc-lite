/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS constraint values for reviewed IDS drafts (#6915), mapped onto the
 * native `IDSConstraint` shapes. Measure values may be authored in a declared
 * unit; IDS stores measures in SI (buildingSMART IDS `units.md`), so they are
 * converted here and the conversion is reported for the review.
 */

import { IFC_DATA_TYPES } from '@ifc-lite/data';
import { translateXsdRegex, type IDSConstraint } from '@ifc-lite/ids';
import { isRecord, onlyKeys } from './proposal-json';

/** Declared units the native IDS validator can compare, and their SI factor. */
const UNITS: Record<string, { kind: 'length' | 'area' | 'volume'; factor: number }> = {
  mm: { kind: 'length', factor: 1e-3 }, cm: { kind: 'length', factor: 1e-2 }, m: { kind: 'length', factor: 1 },
  mm2: { kind: 'area', factor: 1e-6 }, cm2: { kind: 'area', factor: 1e-4 }, m2: { kind: 'area', factor: 1 },
  mm3: { kind: 'volume', factor: 1e-9 }, cm3: { kind: 'volume', factor: 1e-6 }, m3: { kind: 'volume', factor: 1 },
};
/** The measure data types the native validator rescales from model units to SI (`bridge/units.ts`). */
const MEASURE_KIND: Record<string, 'length' | 'area' | 'volume'> = {
  IFCLENGTHMEASURE: 'length', IFCPOSITIVELENGTHMEASURE: 'length', IFCAREAMEASURE: 'area', IFCVOLUMEMEASURE: 'volume',
};
export const DECLARED_UNITS = Object.keys(UNITS);
const SI_UNIT = { length: 'm', area: 'm²', volume: 'm³' } as const;

/** The SI unit the native validator compares a measure dataType in, or null for a non-measure type. */
export function siUnitOf(dataType: string | undefined): string | null {
  const kind = dataType ? MEASURE_KIND[dataType] : undefined;
  return kind ? SI_UNIT[kind] : null;
}

/**
 * The numbers of `constraint` (stored in SI) read back in the declared `unit`,
 * so the review shows "2400 mm → 2.4 m" for the current value, edits included.
 * Non-numeric values have no conversion.
 */
export function unitConversions(constraint: IDSConstraint | undefined, unit: string): Array<{ authored: number; si: number }> {
  const factor = UNITS[unit]?.factor;
  if (!constraint || !factor) return [];
  const values = constraint.type === 'simpleValue' ? [constraint.value]
    : constraint.type === 'enumeration' ? constraint.values
      : constraint.type === 'bounds' ? [constraint.minInclusive, constraint.minExclusive, constraint.maxInclusive, constraint.maxExclusive] : [];
  return values.flatMap(value => {
    const si = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(si) ? [{ authored: Number((si / factor).toPrecision(12)), si }] : [];
  });
}

/** The XSD type behind an IFC data type, or null when the name is not an IFC data type. */
export function dataTypeBase(dataType: string): string | null {
  return IFC_DATA_TYPES.find(entry => entry.name === dataType)?.backingType ?? null;
}

type Scalar = string | number | boolean;
const isScalar = (value: unknown): value is Scalar =>
  typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));

export interface ConstraintContext {
  at: string;
  /** XSD base of the restriction; follows the property's dataType when declared. */
  base?: string | null;
  /** SI factor for a declared measure unit; numbers are multiplied by it. */
  factor?: number;
}

/** 1e-3 * 2400 must print as 2.4, not 2.4000000000000004. */
const si = (value: number, factor: number): number => Number((value * factor).toPrecision(12));

function scalarText(value: Scalar, context: ConstraintContext, at: string): string {
  if (typeof value === 'number') return String(context.factor ? si(value, context.factor) : value);
  if (context.factor) throw new Error(`${at} must be a number when a unit is declared`);
  return String(value);
}

function bound(value: unknown, key: string, context: ConstraintContext): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${context.at}.${key} must be a finite number`);
  return context.factor ? si(value, context.factor) : value;
}

/**
 * A string, number or boolean is a simple value; objects use the native
 * constraint names: {type: simpleValue|pattern|enumeration|bounds}.
 */
export function parseConstraint(value: unknown, context: ConstraintContext): IDSConstraint {
  const { at } = context;
  if (isScalar(value)) return { type: 'simpleValue', value: scalarText(value, context, at) };
  if (!isRecord(value)) throw new Error(`${at} must be a value or a {type: simpleValue|pattern|enumeration|bounds} constraint`);
  const base = context.base ?? undefined;
  switch (value.type) {
    case 'simpleValue':
      onlyKeys(value, ['type', 'value'], at);
      if (!isScalar(value.value)) throw new Error(`${at}.value must be text, a number or a boolean`);
      return { type: 'simpleValue', value: scalarText(value.value, context, `${at}.value`) };
    case 'pattern': {
      onlyKeys(value, ['type', 'pattern'], at);
      if (typeof value.pattern !== 'string' || !value.pattern || value.pattern.length > 500) throw new Error(`${at}.pattern must be an XSD regular expression of at most 500 characters`);
      if (context.factor) throw new Error(`${at}: a pattern cannot carry a unit; use bounds or a number`);
      const translated = translateXsdRegex(value.pattern);
      if (!translated.supported) throw new Error(`${at}.pattern cannot be checked natively: ${translated.reason}`);
      return { type: 'pattern', pattern: value.pattern, base: base ?? 'xs:string' };
    }
    case 'enumeration': {
      onlyKeys(value, ['type', 'values'], at);
      if (!Array.isArray(value.values) || value.values.length === 0 || value.values.length > 100 || !value.values.every(isScalar)) {
        throw new Error(`${at}.values must list 1 to 100 values`);
      }
      const values = value.values.map((item, index) => scalarText(item, context, `${at}.values[${index}]`));
      if (new Set(values).size !== values.length) throw new Error(`${at}.values repeats a value`);
      return { type: 'enumeration', values, base: base ?? (value.values.every(item => typeof item === 'number') ? 'xs:double' : 'xs:string') };
    }
    case 'bounds': {
      onlyKeys(value, ['type', 'minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive'], at);
      const result = {
        minInclusive: bound(value.minInclusive, 'minInclusive', context), maxInclusive: bound(value.maxInclusive, 'maxInclusive', context),
        minExclusive: bound(value.minExclusive, 'minExclusive', context), maxExclusive: bound(value.maxExclusive, 'maxExclusive', context),
      };
      const defined = Object.entries(result).filter(([, v]) => v !== undefined);
      if (!defined.length) throw new Error(`${at} needs at least one of minInclusive, maxInclusive, minExclusive, maxExclusive`);
      if (result.minInclusive !== undefined && result.minExclusive !== undefined) throw new Error(`${at} may set minInclusive or minExclusive, not both`);
      if (result.maxInclusive !== undefined && result.maxExclusive !== undefined) throw new Error(`${at} may set maxInclusive or maxExclusive, not both`);
      const low = result.minInclusive ?? result.minExclusive, high = result.maxInclusive ?? result.maxExclusive;
      if (low !== undefined && high !== undefined && low > high) throw new Error(`${at} has its lower bound above its upper bound`);
      if (low !== undefined && low === high && (result.minExclusive !== undefined || result.maxExclusive !== undefined)) {
        throw new Error(`${at} admits no value: an exclusive bound equals the other bound; use minInclusive and maxInclusive for one exact value`);
      }
      if (base && base !== 'xs:double' && base !== 'xs:integer' && base !== 'xs:decimal') throw new Error(`${at}: bounds need a numeric dataType, not one backed by ${base}`);
      return { type: 'bounds', ...Object.fromEntries(defined), base: base ?? 'xs:double' };
    }
    default:
      throw new Error(`${at}.type must be simpleValue, pattern, enumeration or bounds`);
  }
}

/**
 * The SI factor for a property value authored in `unit`, which must match the
 * declared measure dataType. Refused when the validator would not rescale it.
 */
export function unitFactor(unit: unknown, dataType: string | undefined, at: string): number | undefined {
  if (unit === undefined) return undefined;
  const declared = typeof unit === 'string' ? UNITS[unit] : undefined;
  if (!declared) throw new Error(`${at}.unit must be one of ${DECLARED_UNITS.join(', ')}; other units cannot be converted natively, so state the value in SI or list the requirement as unsupported`);
  const measure = dataType ? MEASURE_KIND[dataType] : undefined;
  if (!measure) throw new Error(`${at}.unit needs dataType ${Object.keys(MEASURE_KIND).join(', ')}`);
  if (measure !== declared.kind) throw new Error(`${at}.unit ${unit} is a ${declared.kind} unit but ${dataType} is a ${measure} measure`);
  return declared.factor;
}
