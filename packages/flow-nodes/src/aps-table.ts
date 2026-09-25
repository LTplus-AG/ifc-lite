/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model Derivative property collection → flow `Table` (#5634).
 *
 * `GET …/metadata/{guid}/properties` returns
 * `{ data: { type: 'properties', collection: [{ objectid, name, externalId, properties }] } }`
 * where `properties` maps a display group (`Identity Data`, `Dimensions`, …)
 * to its name/value pairs. One row per object:
 *   - `objectid` (viewer dbId), `externalId` (for Revit the element UniqueId),
 *     `name`;
 *   - `category`: the first `Category` value found, the hidden `__category__`
 *     group first (the Revit viewer's property database keeps it there), then
 *     every other group in response order;
 *   - `IfcGUID`: promoted from whichever group carries it (Revit writes it
 *     under `IFC Parameters`), so the table joins with an IFC export's
 *     `GlobalId` via `table.joinByKey` without the caller knowing the group;
 *   - every property flattened to a `Group.Property` column.
 * A column whose values are all numbers is typed `real`, all booleans
 * `boolean`; anything else is `string`. Nothing is dropped: a row without an
 * `externalId` keeps a null there, and the caller picks the key column.
 */

import type { Cell, Column, ColumnType, Row, Table } from '@ifc-lite/flow';

interface CollectionItem {
  readonly objectid?: unknown;
  readonly name?: unknown;
  readonly externalId?: unknown;
  readonly properties?: unknown;
}

const FIXED = ['objectid', 'externalId', 'name', 'category', 'IfcGUID'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (Array.isArray(v)) return v.map((x) => (isRecord(x) || Array.isArray(x) ? JSON.stringify(x) : String(x))).join('; ');
  return JSON.stringify(v);
}

/**
 * Flatten a property tree to `path → value` leaves. Iterative (a JSON tree
 * has no cycles, but a deep one must not cost stack), arrays kept as leaves.
 */
function flatten(properties: Record<string, unknown>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const stack: Array<[string, Record<string, unknown>]> = [['', properties]];
  while (stack.length > 0) {
    const [prefix, obj] = stack.pop()!;
    const groups: Array<[string, Record<string, unknown>]> = [];
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (isRecord(v)) groups.push([path, v]);
      else out.set(path, v);
    }
    // Reversed, so groups pop off the stack in response order.
    for (let g = groups.length - 1; g >= 0; g--) stack.push(groups[g]);
  }
  return out;
}

function findProperty(properties: Record<string, unknown>, prop: string, preferGroup?: string): unknown {
  const groups = Object.entries(properties).filter((e): e is [string, Record<string, unknown>] => isRecord(e[1]));
  if (preferGroup) groups.sort(([a], [b]) => Number(b === preferGroup) - Number(a === preferGroup));
  for (const [, group] of groups) {
    const v = group[prop];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function inferType(values: readonly Cell[]): ColumnType {
  const present = values.filter((v) => v !== null);
  if (present.length > 0 && present.every((v) => typeof v === 'number')) return 'real';
  if (present.length > 0 && present.every((v) => typeof v === 'boolean')) return 'boolean';
  return 'string';
}

/** Build the table; `key` must name one of its columns. */
export function propertiesToTable(collection: readonly unknown[], key: string): Table {
  const fixedRows: Array<Record<string, Cell>> = [];
  const flatRows: Array<Map<string, unknown>> = [];
  const propColumns: string[] = [];
  const seen = new Set<string>();

  for (const raw of collection) {
    if (!isRecord(raw)) continue;
    const item = raw as CollectionItem;
    const properties = isRecord(item.properties) ? item.properties : {};
    fixedRows.push({
      objectid: typeof item.objectid === 'number' ? item.objectid : null,
      externalId: typeof item.externalId === 'string' && item.externalId.length > 0 ? item.externalId : null,
      name: typeof item.name === 'string' ? item.name : null,
      category: toCell(findProperty(properties, 'Category', '__category__')),
      IfcGUID: toCell(findProperty(properties, 'IfcGUID', 'IFC Parameters')),
    });
    const flat = flatten(properties);
    flatRows.push(flat);
    for (const path of flat.keys()) {
      if (seen.has(path)) continue;
      seen.add(path);
      propColumns.push(path);
    }
  }

  // A top-level scalar property named like a fixed column would overwrite it.
  const reserved = new Set<string>(FIXED);
  const columnName = new Map(propColumns.map((p) => [p, reserved.has(p) ? `properties.${p}` : p]));

  const rows: Row[] = fixedRows.map((fixed, i) => {
    const row: Record<string, Cell> = { ...fixed };
    for (const path of propColumns) row[columnName.get(path)!] = toCell(flatRows[i].get(path));
    return row;
  });

  const columns: Column[] = [
    { name: 'objectid', type: 'integer' },
    { name: 'externalId', type: 'identifier' },
    { name: 'name', type: 'label' },
    { name: 'category', type: 'label' },
    { name: 'IfcGUID', type: 'identifier' },
    ...propColumns.map((p) => {
      const name = columnName.get(p)!;
      return { name, type: inferType(rows.map((r) => r[name])) };
    }),
  ];
  // Mixed columns were inferred `string`: make their cells agree.
  for (const col of columns) {
    if (col.type !== 'string') continue;
    for (const row of rows as Array<Record<string, Cell>>) {
      const v = row[col.name];
      if (v !== null && typeof v !== 'string') row[col.name] = String(v);
    }
  }
  if (!columns.some((c) => c.name === key)) {
    throw new Error(`key column "${key}" is not in the table (columns: ${columns.slice(0, 12).map((c) => c.name).join(', ')}${columns.length > 12 ? ', …' : ''})`);
  }
  return { columns, rows, key };
}
