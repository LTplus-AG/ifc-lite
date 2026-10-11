/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Native target of each reviewed source requirement (#7375). P16 extracted
 * the requirement and verified its span; this decides, explicitly and
 * without a provider call, which native owner could check it: an IDS
 * specification, an information rule over a geometry-derived quantity
 * (`Qto_*`), a manual item in a native document, or nothing (unresolved,
 * with the reason). Nothing here builds, runs or saves a draft.
 */

import { xxhash64Hex } from '@ifc-lite/cache';
import { getPropertySets, type IfcSchemaVersion } from '@ifc-lite/data';
import { siUnitOf } from '@/lib/check-authoring/ids-constraint';
import type { IFCVersion } from '@ifc-lite/ids';
import type { ExtractedRequirement } from './requirement-proposal';
import type { SourceText } from './source-texts';
import type { Passage, SpanCheck } from './spans';

export type RequirementTarget = 'ids' | 'geometry' | 'manual' | 'unresolved';
export type UnresolvedReason = 'span' | 'source-missing' | 'source-changed' | 'scope' | 'property' | 'unknown' | 'version' | 'operator' | 'value'
  | 'unit' | 'dimension' | 'measure' | 'native';

export interface Typed { dataType: string; unit?: string }

/** The attached text a verified span quotes, as it is now: its id, title and content revision. */
export interface SourceRevision { source: string; title: string; revision: string; characters: number }

export interface ClassifiedRequirement {
  requirement: ExtractedRequirement;
  check: SpanCheck;
  target: RequirementTarget;
  /** Why the requirement has no native target; set only for `unresolved`. */
  reason?: UnresolvedReason;
  /** The native validator's own refusal, for `native`. */
  detail?: string;
  /** Set whenever the span verified against an unchanged source, whatever the target. */
  source?: SourceRevision;
  /** The type a typed value is checked as (the schema's own for a standard property) and, for a measured value, its stated unit. */
  typed?: Typed;
}

/** Portable content revision of an attached text, recorded with each native record for provenance. */
export function textRevision(text: string): string {
  return xxhash64Hex(new TextEncoder().encode(text));
}

/**
 * The attached source a span cites, checked against the passages frozen into
 * the conversation: every frozen passage of that source must still read the
 * same at the same offsets, otherwise the text changed after the assistant
 * saw it (detached, replaced or re-attached under the same id).
 */
export function sourceRevisionOf(id: string, passages: readonly Passage[], sources: readonly SourceText[]): SourceRevision | 'source-missing' | 'source-changed' {
  const source = sources.find(candidate => candidate.id === id);
  if (!source) return 'source-missing';
  const frozen = passages.filter(passage => passage.source === id);
  if (!frozen.length || frozen.some(passage => source.text.slice(passage.start, passage.end) !== passage.text)) return 'source-changed';
  return { source: id, title: source.title, revision: textRevision(source.text), characters: source.text.length };
}

/** IFC attributes an IDS attribute facet may require by name; any other bare property name is ambiguous. */
const IDS_ATTRIBUTES = new Set(['Name', 'Description', 'ObjectType', 'Tag', 'LongName', 'PredefinedType']);

export type PropertyTarget = { kind: 'attribute'; name: string } | { kind: 'property'; set: string; name: string };

/** `Pset_WallCommon.FireRating` or an IFC attribute name; anything else is not addressable natively. */
export function propertyTarget(property: string): PropertyTarget | null {
  const qualified = /^([A-Za-z][A-Za-z0-9_]{0,99})\.([A-Za-z][A-Za-z0-9_ ]{0,99})$/.exec(property.trim());
  if (qualified) return { kind: 'property', set: qualified[1], name: qualified[2].trim() };
  return IDS_ATTRIBUTES.has(property.trim()) ? { kind: 'attribute', name: property.trim() } : null;
}

const MEASURES = { length: 'IFCLENGTHMEASURE', area: 'IFCAREAMEASURE', volume: 'IFCVOLUMEMEASURE' } as const;

/** A stated unit in the spelling the native converters take (`m²` → `m2`), with its IFC measure type. */
export function measureUnit(unit: string): { unit: string; dataType: string } | null {
  const normal = unit.trim().replace('²', '2').replace('³', '3');
  const match = /^(mm|cm|m)([23]?)$/.exec(normal);
  if (!match) return null;
  return { unit: normal, dataType: MEASURES[match[2] === '2' ? 'area' : match[2] === '3' ? 'volume' : 'length'] };
}

/** The schema tables: the property sets and quantity sets each IFC version defines. */
type SchemaTable = 'IFC2X3' | 'IFC4' | 'IFC4X3';
const TABLES: Record<SchemaTable, IfcSchemaVersion> = { IFC2X3: 'IFC2X3', IFC4: 'IFC4', IFC4X3: 'IFC4X3_ADD2' };
const TABLE_OF: Record<IFCVersion, SchemaTable> = { IFC2X3: 'IFC2X3', IFC4: 'IFC4', IFC4X3: 'IFC4X3', IFC4X3_ADD2: 'IFC4X3' };

/** The type each schema table declares for a standard property or quantity (`IFCPOSITIVELENGTHMEASURE`); empty when none does. */
export type SchemaMeasures = (set: string, property: string) => ReadonlyMap<SchemaTable, string>;

let schemaMeasures: Promise<SchemaMeasures> | null = null;

async function readSchemaMeasures(): Promise<SchemaMeasures> {
  const measures = new Map<string, Map<SchemaTable, string>>();
  for (const table of Object.keys(TABLES) as SchemaTable[]) {
    for (const set of await getPropertySets(TABLES[table])) for (const property of set.properties) {
      if (!property.dataType) continue;
      const key = `${set.name}.${property.name}`;
      const declared = measures.get(key) ?? new Map<SchemaTable, string>();
      declared.set(table, property.dataType.toUpperCase());
      measures.set(key, declared);
    }
  }
  const none = new Map<SchemaTable, string>();
  return (set: string, name: string) => measures.get(`${set}.${name}`) ?? none;
}

/** Declared types of every standard `Pset_*` property and `Qto_*` quantity per IFC version, read once from the bundled schema tables. */
export function loadSchemaMeasures(): Promise<SchemaMeasures> {
  // A failure anywhere is not cached: the next review tries again.
  schemaMeasures ??= readSchemaMeasures().catch((failure: unknown) => { schemaMeasures = null; throw failure; });
  return schemaMeasures;
}

const STANDARD_SET = /^(Pset|Qto)_/;
/** Length measures the native validator rescales but the authoring converters do not (`ids-constraint.ts`). */
const UNCONVERTED_LENGTHS = new Set(['IFCNONNEGATIVELENGTHMEASURE']);

/**
 * The one type a standard property is checked as in every targeted IFC
 * version. An IDS specification carries a single dataType for all its
 * versions, so the versions must agree; an information rule compares in SI
 * whatever the version, so it only needs the declared types to agree in kind
 * (the generated tables define quantity sets for IFC4X3 only).
 */
function declaredType(target: { set: string; name: string }, schema: SchemaMeasures, versions: readonly IFCVersion[] | 'any'): string | 'unknown' | 'version' {
  const declared = schema(target.set, target.name);
  if (!declared.size) return 'unknown';
  // With no targeted version (no model with an IDS version is loaded) every table that declares it must agree.
  const tables = versions === 'any' || !versions.length ? null : [...new Set(versions.map(version => TABLE_OF[version]))];
  const types = tables ? tables.map(table => declared.get(table)) : [...declared.values()];
  if (types.some(type => type === undefined)) return 'version';
  const distinct = new Set(versions === 'any' ? types.map(type => siUnitOf(type) ?? type) : types);
  return distinct.size === 1 ? types[0]! : 'version';
}

/** A standard property every targeted IFC version defines; IDS would audit any other as not in its property set. */
function definedIn(target: { set: string; name: string }, schema: SchemaMeasures, versions: readonly IFCVersion[]): 'unknown' | 'version' | null {
  if (!STANDARD_SET.test(target.set)) return null;
  const declared = schema(target.set, target.name);
  if (!declared.size) return 'unknown';
  return versions.some(version => !declared.has(TABLE_OF[version])) ? 'version' : null;
}

/**
 * The type a numeric value stated in `unit` is checked as: a standard
 * property or quantity is checked as the type the schema declares for it,
 * which must measure what the unit measures (a width is never compared in
 * mm², a weight never in m³); a custom property set declares nothing, so the
 * unit's own type is used.
 */
function measuredType(target: { set: string; name: string }, unit: string, schema: SchemaMeasures, versions: readonly IFCVersion[] | 'any'): Typed | UnresolvedReason {
  const stated = measureUnit(unit);
  if (!stated) return 'unit';
  if (!STANDARD_SET.test(target.set)) return stated;
  const declared = declaredType(target, schema, versions);
  if (declared === 'unknown' || declared === 'version') return declared;
  if (UNCONVERTED_LENGTHS.has(declared)) return 'measure';
  return siUnitOf(declared) === siUnitOf(stated.dataType) ? { unit: stated.unit, dataType: declared } : 'dimension';
}

/** A value with no unit on a declared measure is ambiguous (model units); a boolean is checked as the declared boolean type. */
function plainType(target: { set: string; name: string }, value: unknown, schema: SchemaMeasures, versions: readonly IFCVersion[]): Typed | null | UnresolvedReason {
  const values = Array.isArray(value) ? value : [value];
  if (!STANDARD_SET.test(target.set)) return values.some(item => typeof item === 'boolean') ? { dataType: 'IFCBOOLEAN' } : null;
  const declared = declaredType(target, schema, versions);
  if (declared === 'version') return declared;
  const type = declared === 'unknown' ? null : declared;
  if (values.some(item => typeof item === 'number') && type && (siUnitOf(type) || UNCONVERTED_LENGTHS.has(type))) return 'unit';
  if (values.some(item => typeof item === 'boolean')) {
    if (type === null) return 'unknown';
    return type === 'IFCBOOLEAN' || type === 'IFCLOGICAL' ? { dataType: type } : 'value';
  }
  return null;
}

const GEOMETRY_OPERATORS = new Set(['equals', 'notEquals', 'atLeast', 'atMost']);

/**
 * Shape-level target for the IFC versions an IDS draft would target; the
 * native validators still have the last word (see `requirement-dispatch.ts`).
 */
export function classifyRequirement(requirement: ExtractedRequirement, check: SpanCheck, source: SourceRevision | 'source-missing' | 'source-changed',
  schema: SchemaMeasures, versions: readonly IFCVersion[]): ClassifiedRequirement {
  if (check.status !== 'verified') return { requirement, check, target: 'unresolved', reason: 'span' };
  if (typeof source === 'string') return { requirement, check, target: 'unresolved', reason: source };
  // From here the span verified against an unchanged source: every outcome keeps that provenance.
  const unresolved = (reason: UnresolvedReason): ClassifiedRequirement => ({ requirement, check, target: 'unresolved', reason, source });
  const resolved = (target: RequirementTarget, typed?: Typed | null): ClassifiedRequirement =>
    ({ requirement, check, target, source, ...(typed ? { typed } : {}) });
  const { appliesTo, property, value, unit } = requirement;
  // Nothing names what to check on which elements: a person checks it, from the document.
  if (!appliesTo?.ifcClass || !property) return resolved('manual');
  // A linked-data class narrows the IFC class; checking the whole IFC class would widen the requirement.
  if (appliesTo.ontologyClass !== undefined) return unresolved('scope');
  const target = propertyTarget(property);
  if (!target) return unresolved('property');
  // A stated value with no comparison (or "exists") is never reduced to an existence check that drops it.
  if (value !== undefined && (requirement.operator === undefined || requirement.operator === 'exists')) return unresolved('value');
  const operator = requirement.operator ?? 'exists';
  if (target.kind === 'property' && target.set.startsWith('Qto_') && GEOMETRY_OPERATORS.has(operator)) {
    if (typeof value !== 'number') return unresolved('value');
    if (unit === undefined) return unresolved('unit');
    const typed = measuredType(target, unit, schema, 'any');
    return typeof typed === 'string' ? unresolved(typed) : resolved('geometry', typed);
  }
  // IDS cannot require the unit a value is recorded in, only constrain a value.
  if (unit !== undefined && operator === 'exists') return unresolved('unit');
  // IDS has no negated value constraint.
  if (operator === 'notEquals') return unresolved('operator');
  if ((operator === 'atLeast' || operator === 'atMost') && typeof value !== 'number') return unresolved('value');
  if (operator === 'matches' && typeof value !== 'string') return unresolved('value');
  if (operator === 'oneOf' && !Array.isArray(value)) return unresolved('value');
  if (operator === 'equals' && (Array.isArray(value) || value === undefined)) return unresolved('value');
  // Whatever the value, an IDS check names a property every targeted version defines.
  const undefinedIn = target.kind === 'property' ? definedIn(target, schema, versions) : null;
  if (undefinedIn) return unresolved(undefinedIn);
  if (operator === 'exists' || operator === 'matches' || target.kind === 'attribute') return unit === undefined ? resolved('ids') : unresolved('unit');
  if (unit === undefined) {
    const typed = plainType(target, value, schema, versions);
    return typeof typed === 'string' ? unresolved(typed) : resolved('ids', typed);
  }
  if (Array.isArray(value) ? !value.every(item => typeof item === 'number') : typeof value !== 'number') return unresolved('unit');
  // Every operator, `oneOf` included, is checked against the declared measure of every targeted version.
  const typed = measuredType(target, unit, schema, versions);
  return typeof typed === 'string' ? unresolved(typed) : resolved('ids', typed);
}
