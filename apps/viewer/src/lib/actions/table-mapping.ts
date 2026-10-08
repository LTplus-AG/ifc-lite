/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `table.mapping` (viewer AI P15): how the columns of a supplied table map to
 * native model data. One identity column names the element (GlobalId, Tag or
 * Name, each required to be unique); every data column names an exact
 * property, quantity or IfcRoot attribute with its value type and, for
 * measures, the unit the table is written in. A mapping is a reviewable
 * description only: rows become a `model.changes` batch after review.
 */

import { EDITABLE_ATTRIBUTES, type EditableAttribute } from '@ifc-lite/ai/artifacts';

export const IDENTITY_KEYS = ['GlobalId', 'Tag', 'Name'] as const;
export type IdentityKey = typeof IDENTITY_KEYS[number];
export const COLUMN_VALUE_TYPES = ['text', 'real', 'integer', 'boolean'] as const;
export type ColumnValueType = typeof COLUMN_VALUE_TYPES[number];
export type MeasureKind = 'length' | 'area' | 'volume';

/** Units a table may declare, with their factor to the SI base unit. */
export const TABLE_UNITS = {
  mm: { kind: 'length', si: 1e-3 }, cm: { kind: 'length', si: 1e-2 }, m: { kind: 'length', si: 1 },
  in: { kind: 'length', si: 0.0254 }, ft: { kind: 'length', si: 0.3048 },
  mm2: { kind: 'area', si: 1e-6 }, cm2: { kind: 'area', si: 1e-4 }, m2: { kind: 'area', si: 1 }, ft2: { kind: 'area', si: 0.09290304 },
  mm3: { kind: 'volume', si: 1e-9 }, cm3: { kind: 'volume', si: 1e-6 }, m3: { kind: 'volume', si: 1 }, l: { kind: 'volume', si: 1e-3 },
  ft3: { kind: 'volume', si: 0.028316846592 },
} as const satisfies Record<string, { kind: MeasureKind; si: number }>;
export type TableUnit = keyof typeof TABLE_UNITS;

export type TableColumnTarget =
  | { column: string; target: 'property'; pset: string; name: string; valueType: ColumnValueType; unit?: TableUnit }
  | { column: string; target: 'quantity'; qset: string; name: string; unit?: TableUnit }
  | { column: string; target: 'attribute'; name: EditableAttribute };

export interface TableMapping {
  version: 1;
  kind: 'table.mapping';
  title: string;
  rationale?: string;
  identity: { column: string; key: IdentityKey };
  columns: TableColumnTarget[];
}

export const TABLE_MAPPING_COLUMN_LIMIT = 100;

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const isUnit = (value: unknown): value is TableUnit => typeof value === 'string' && Object.hasOwn(TABLE_UNITS, value);

function unitOf(value: Record<string, unknown>, at: string): { unit?: TableUnit } {
  if (value.unit === undefined || value.unit === null) return {};
  if (!isUnit(value.unit)) throw new Error(`${at} has an unknown unit; use one of ${Object.keys(TABLE_UNITS).join(', ')}`);
  return { unit: value.unit };
}

function column(value: unknown, index: number): TableColumnTarget {
  const at = `Column mapping ${index + 1}`;
  if (!record(value) || !text(value.column)) throw new Error(`${at} needs the table column name`);
  switch (value.target) {
    case 'property':
      if (!text(value.pset) || !text(value.name)) throw new Error(`${at} needs a property set and property name`);
      if (!COLUMN_VALUE_TYPES.includes(value.valueType as ColumnValueType)) throw new Error(`${at} needs a valueType (${COLUMN_VALUE_TYPES.join(', ')})`);
      return { column: value.column, target: 'property', pset: value.pset.trim(), name: value.name.trim(),
        valueType: value.valueType as ColumnValueType, ...unitOf(value, at) };
    case 'quantity':
      if (!text(value.qset) || !text(value.name)) throw new Error(`${at} needs a quantity set and quantity name`);
      return { column: value.column, target: 'quantity', qset: value.qset.trim(), name: value.name.trim(), ...unitOf(value, at) };
    case 'attribute':
      if (!EDITABLE_ATTRIBUTES.includes(value.name as EditableAttribute)) throw new Error(`${at} can only set ${EDITABLE_ATTRIBUTES.join(', ')}`);
      return { column: value.column, target: 'attribute', name: value.name as EditableAttribute };
    default:
      throw new Error(`${at} must target a property, quantity or attribute`);
  }
}

/** Strict, bounded parse of a complete JSON answer (optionally fenced). Throws with a reason a person can act on. */
export function parseTableMapping(answer: string): TableMapping {
  if (answer.length > 100_000) throw new Error('The table mapping exceeds the text limit');
  const trimmed = answer.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  const value: unknown = JSON.parse(fenced ? fenced[1] : trimmed);
  if (!record(value) || value.version !== 1 || value.kind !== 'table.mapping') throw new Error('Not a table mapping');
  if (!text(value.title)) throw new Error('A table mapping needs a short title');
  if (value.rationale !== undefined && !text(value.rationale, 2000)) throw new Error('The rationale must be text');
  const identity = value.identity;
  if (!record(identity) || !text(identity.column) || !IDENTITY_KEYS.includes(identity.key as IdentityKey)) {
    throw new Error(`The identity must name a column and a key (${IDENTITY_KEYS.join(', ')})`);
  }
  if (!Array.isArray(value.columns) || value.columns.length === 0) throw new Error('A table mapping needs at least one data column');
  if (value.columns.length > TABLE_MAPPING_COLUMN_LIMIT) throw new Error(`A table mapping may map at most ${TABLE_MAPPING_COLUMN_LIMIT} columns`);
  return { version: 1, kind: 'table.mapping', title: value.title.trim(),
    ...(typeof value.rationale === 'string' ? { rationale: value.rationale } : {}),
    identity: { column: identity.column, key: identity.key as IdentityKey }, columns: value.columns.map(column) };
}

export type MappingProblem =
  | { kind: 'unknown-column'; column: string }
  | { kind: 'identity-mapped'; column: string }
  | { kind: 'column-twice'; column: string }
  | { kind: 'target-twice'; column: string; field: string }
  | { kind: 'unit-needs-number'; column: string }
  | { kind: 'empty-name'; column: string };

export function targetField(target: TableColumnTarget): string {
  if (target.target === 'property') return `${target.pset}.${target.name}`;
  if (target.target === 'quantity') return `${target.qset}.${target.name}`;
  return target.name;
}

/** Problems that make a mapping unusable against these table headers; empty when it can convert rows. */
export function validateTableMapping(mapping: TableMapping, headers: readonly string[]): MappingProblem[] {
  const known = new Set(headers);
  const problems: MappingProblem[] = [];
  if (!known.has(mapping.identity.column)) problems.push({ kind: 'unknown-column', column: mapping.identity.column });
  const columns = new Set<string>();
  const fields = new Set<string>();
  for (const target of mapping.columns) {
    if (!known.has(target.column)) problems.push({ kind: 'unknown-column', column: target.column });
    if (target.column === mapping.identity.column) problems.push({ kind: 'identity-mapped', column: target.column });
    if (columns.has(target.column)) problems.push({ kind: 'column-twice', column: target.column });
    columns.add(target.column);
    const empty = target.target === 'property' ? !target.pset.trim() || !target.name.trim()
      : target.target === 'quantity' ? !target.qset.trim() || !target.name.trim() : false;
    if (empty) problems.push({ kind: 'empty-name', column: target.column });
    // Structured, not the dotted label: `A.B` + `C` and `A` + `B.C` are different values.
    const field = JSON.stringify(target.target === 'property' ? ['property', target.pset, target.name]
      : target.target === 'quantity' ? ['quantity', target.qset, target.name] : ['attribute', target.name]);
    if (fields.has(field)) problems.push({ kind: 'target-twice', column: target.column, field: targetField(target) });
    fields.add(field);
    if (target.target === 'property' && target.unit && target.valueType !== 'real' && target.valueType !== 'integer') {
      problems.push({ kind: 'unit-needs-number', column: target.column });
    }
  }
  return problems;
}

/** Guidance for providers: the exact contract, kept short so it fits beside the table sample. */
export const TABLE_MAPPING_OUTPUT_GUIDANCE =
  'Return only JSON {"version":1,"kind":"table.mapping","title":"Short title","rationale":"Why",'
  + '"identity":{"column":"<header>","key":"GlobalId"},"columns":[{"column":"<header>","target":"property",'
  + '"pset":"Pset_WallCommon","name":"FireRating","valueType":"text"}]}. identity.key is GlobalId, Tag or Name. '
  + 'Targets: property (pset, name, valueType text|real|integer|boolean, optional unit), quantity (qset, name, optional unit; '
  + 'only quantities that already exist are updated), attribute (name: Name, Description, ObjectType or Tag). '
  + `Units: ${Object.keys(TABLE_UNITS).join(', ')}; give a unit only when the header or values state it. `
  + 'Use exact header names. Leave a column out when its meaning is unclear; never invent property names the model '
  + 'context does not support unless the header names them. The user reviews and edits the mapping before any change.';
