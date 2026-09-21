/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Table`: the tabular value that goes to and comes back from Excel/CSV.
 *
 * Every column carries an IFC value type and, when it maps onto a property,
 * the `pset`/`prop` it was read from — so a round trip through a spreadsheet
 * does not lose the difference between `IfcReal` 2.0 and `IfcInteger` 2, and
 * a unit is never guessed on the way back. A table always names its key
 * column: a keyless sheet cannot be matched back to entities and is refused.
 *
 * Long format `(GlobalId, Pset, Prop, Value, Type, Unit)` is the canonical
 * entity/pset/property shape; `pivot` widens it to one row per entity for a
 * sheet and `groupBy` splits it per entity for lifting.
 */

import type { GroupKey, Scalar } from './values.js';

/** IFC value types spelled as strings so they survive JSON documents. */
export type ColumnType =
  | 'string'
  | 'real'
  | 'integer'
  | 'boolean'
  | 'logical'
  | 'label'
  | 'identifier'
  | 'text'
  | 'enum'
  | 'reference'
  | 'list';

export const COLUMN_TYPES: readonly ColumnType[] = [
  'string', 'real', 'integer', 'boolean', 'logical', 'label', 'identifier', 'text', 'enum', 'reference', 'list',
];

export interface Column {
  readonly name: string;
  readonly type: ColumnType;
  readonly unit?: string;
  /** The property this column was read from, when it maps onto one. */
  readonly binding?: { readonly pset: string; readonly prop: string };
}

export type Cell = Scalar;
export type Row = Readonly<Record<string, Cell>>;

export interface Table {
  readonly columns: readonly Column[];
  readonly rows: readonly Row[];
  /** Name of the column whose values identify a row (usually `GlobalId`). */
  readonly key: string;
}

export interface TableProblem {
  readonly path: string;
  readonly message: string;
}

/** Structural validation of an untrusted table value. */
export function validateTable(value: unknown, path = 'table'): TableProblem[] {
  const problems: TableProblem[] = [];
  if (!value || typeof value !== 'object') return [{ path, message: 'must be an object' }];
  const t = value as Partial<Table>;
  if (!Array.isArray(t.columns)) problems.push({ path: `${path}.columns`, message: 'must be an array' });
  if (!Array.isArray(t.rows)) problems.push({ path: `${path}.rows`, message: 'must be an array' });
  if (typeof t.key !== 'string' || t.key.length === 0) problems.push({ path: `${path}.key`, message: 'must name the key column' });
  if (problems.length > 0) return problems;

  const names = new Set<string>();
  (t.columns as unknown[]).forEach((c, i) => {
    const col = c as Partial<Column>;
    const p = `${path}.columns[${i}]`;
    if (typeof col.name !== 'string' || col.name.length === 0) problems.push({ path: `${p}.name`, message: 'must be a non-empty string' });
    else if (names.has(col.name)) problems.push({ path: `${p}.name`, message: `duplicate column "${col.name}"` });
    else names.add(col.name);
    if (!COLUMN_TYPES.includes(col.type as ColumnType)) problems.push({ path: `${p}.type`, message: `unknown column type "${String(col.type)}"` });
    if (col.unit !== undefined && typeof col.unit !== 'string') problems.push({ path: `${p}.unit`, message: 'must be a string' });
    if (col.binding !== undefined) {
      const b = col.binding as Partial<Column['binding']>;
      if (!b || typeof b.pset !== 'string' || typeof b.prop !== 'string') problems.push({ path: `${p}.binding`, message: 'must be { pset, prop }' });
    }
  });
  if (typeof t.key === 'string' && !names.has(t.key)) problems.push({ path: `${path}.key`, message: `key column "${t.key}" is not a column` });

  (t.rows as unknown[]).forEach((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      problems.push({ path: `${path}.rows[${i}]`, message: 'must be an object' });
      return;
    }
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      if (!names.has(k)) problems.push({ path: `${path}.rows[${i}].${k}`, message: 'not a declared column' });
      else if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        problems.push({ path: `${path}.rows[${i}].${k}`, message: 'cell must be string, number, boolean or null' });
      }
    }
  });
  return problems;
}

export function column(table: Table, name: string): Column | undefined {
  return table.columns.find((c) => c.name === name);
}

/** The row key as a group key; `null`/missing keys are reported, never coerced. */
export function rowKey(table: Table, row: Row): GroupKey | null {
  const v = row[table.key];
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}

export interface GroupedRows {
  readonly branches: ReadonlyMap<GroupKey, readonly Row[]>;
  /** Rows whose grouping column was empty. */
  readonly unkeyed: readonly Row[];
}

/** Split rows into branches by a column's value (defaults to the key column). */
export function groupRows(table: Table, by: string = table.key): GroupedRows {
  const branches = new Map<GroupKey, Row[]>();
  const unkeyed: Row[] = [];
  for (const row of table.rows) {
    const v = row[by];
    if (v === null || v === undefined || v === '') {
      unkeyed.push(row);
      continue;
    }
    const k = String(v);
    const branch = branches.get(k);
    if (branch) branch.push(row);
    else branches.set(k, [row]);
  }
  return { branches, unkeyed };
}

/**
 * Widen a long-format table into one row per `rowKey` with a column per
 * distinct `colKey` value. The pivoted column's type is taken from the
 * `valueCol` column; a duplicate (rowKey, colKey) pair keeps the last
 * value and is reported.
 */
export function pivot(
  table: Table,
  rowKeyCol: string,
  colKeyCol: string,
  valueCol: string,
): { table: Table; duplicates: number } {
  const valueColumn = column(table, valueCol);
  const rows = new Map<GroupKey, Record<string, Cell>>();
  const colNames = new Set<string>();
  let duplicates = 0;
  for (const row of table.rows) {
    const rk = row[rowKeyCol];
    const ck = row[colKeyCol];
    if (rk === null || rk === undefined || rk === '' || ck === null || ck === undefined || ck === '') continue;
    const rkey = String(rk);
    const cname = String(ck);
    colNames.add(cname);
    let target = rows.get(rkey);
    if (!target) {
      target = { [rowKeyCol]: rk };
      rows.set(rkey, target);
    }
    if (cname in target) duplicates += 1;
    target[cname] = row[valueCol] ?? null;
  }
  const keyColumn = column(table, rowKeyCol) ?? { name: rowKeyCol, type: 'identifier' as const };
  const columns: Column[] = [
    keyColumn,
    ...[...colNames].map((name) => ({ name, type: valueColumn?.type ?? 'string', unit: valueColumn?.unit })),
  ];
  return { table: { columns, rows: [...rows.values()], key: rowKeyCol }, duplicates };
}
