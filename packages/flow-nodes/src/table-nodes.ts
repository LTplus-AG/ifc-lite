/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `table.*` — typed tables to and from entities.
 *
 * `table.fromEntities` is the Excel export loop's first half: one row per
 * entity, keyed by GlobalId, every column stamped with the IFC value type
 * and (for properties) its pset/prop binding so `ApplyTable` can write it
 * back without guessing. `table.longFormat` is the canonical
 * (GlobalId, Pset, Prop, Value, Type) shape that `pivot` widens.
 */

import { PropertyValueType } from '@ifc-lite/data';
import { groupRows, pivot, validateTable, type Cell, type Column, type ColumnType, type EntityRef, type GroupKey, type Row, type Table } from '@ifc-lite/flow';
import { findPropertyInSets } from '@ifc-lite/query';
import { ANY_GROUP, ENTITY_LIST, SCALAR_ITEM, SCALAR_LIST, TABLE_ITEM, entityOf, requireCapability, toSdkRef, type FlowNodeDef } from './host.js';

const COLUMN_TYPE_BY_VALUE_TYPE: Readonly<Record<number, ColumnType>> = {
  [PropertyValueType.String]: 'string',
  [PropertyValueType.Real]: 'real',
  [PropertyValueType.Integer]: 'integer',
  [PropertyValueType.Boolean]: 'boolean',
  [PropertyValueType.Logical]: 'logical',
  [PropertyValueType.Label]: 'label',
  [PropertyValueType.Identifier]: 'identifier',
  [PropertyValueType.Text]: 'text',
  [PropertyValueType.Enum]: 'enum',
  [PropertyValueType.Reference]: 'reference',
  [PropertyValueType.List]: 'list',
};

export function columnTypeOf(valueType: number): ColumnType {
  return COLUMN_TYPE_BY_VALUE_TYPE[valueType] ?? 'string';
}

export const VALUE_TYPE_BY_COLUMN_TYPE: Readonly<Record<ColumnType, PropertyValueType>> = {
  string: PropertyValueType.String,
  real: PropertyValueType.Real,
  integer: PropertyValueType.Integer,
  boolean: PropertyValueType.Boolean,
  logical: PropertyValueType.Logical,
  label: PropertyValueType.Label,
  identifier: PropertyValueType.Identifier,
  text: PropertyValueType.Text,
  enum: PropertyValueType.Enum,
  reference: PropertyValueType.Reference,
  list: PropertyValueType.List,
};

const GLOBAL_ID: Column = { name: 'GlobalId', type: 'identifier' };

function tableOf(v: unknown): Table {
  const problems = validateTable(v);
  if (problems.length > 0) throw new Error(`not a table: ${problems.map((p) => `${p.path} ${p.message}`).join('; ')}`);
  return v as Table;
}

/** `Pset_WallCommon.FireRating` → { pset, prop }; a bare name is an attribute column. */
function parsePath(path: string): { pset: string; prop: string } | { attribute: string } {
  const dot = path.indexOf('.');
  if (dot <= 0) return { attribute: path };
  return { pset: path.slice(0, dot), prop: path.slice(dot + 1) };
}

export const tableNodes: FlowNodeDef[] = [
  {
    type: 'table.fromEntities',
    title: 'Table from entities',
    category: 'table',
    doc: 'One row per entity. Columns are `Pset.Prop` paths or attributes (Name, Type, ObjectType).',
    inputs: [{ name: 'entities', type: ENTITY_LIST }],
    outputs: [{ name: 'table', type: TABLE_ITEM }],
    params: [{ name: 'columns', kind: 'json', default: ['Name', 'Pset_WallCommon.FireRating'] }],
    capabilities: ['model.read'],
    reads: 'model',
    run: (ctx, i, p) => {
      requireCapability(ctx, 'model.read');
      const paths = Array.isArray(p.columns) ? (p.columns as unknown[]).map(String) : [];
      const columns: Column[] = [GLOBAL_ID];
      const types = new Map<string, ColumnType>();
      const rows: Record<string, Cell>[] = [];
      for (const ref of i.entities as EntityRef[]) {
        const e = entityOf(ctx, ref);
        const row: Record<string, Cell> = { GlobalId: e.globalId };
        const psets = ctx.host.bim.properties(e.ref);
        for (const path of paths) {
          const parsed = parsePath(path);
          if ('attribute' in parsed) {
            const v = { Name: e.name, Type: e.type, Description: e.description, ObjectType: e.objectType }[parsed.attribute];
            row[path] = v ?? null;
            types.set(path, 'label');
            continue;
          }
          // An entity can carry two same-named sets (type + occurrence); the
          // property may live on the second, so search across all of them.
          const prop = findPropertyInSets(psets, parsed.pset, parsed.prop);
          row[path] = prop?.value ?? null;
          if (prop && !types.has(path)) types.set(path, columnTypeOf(prop.type));
        }
        rows.push(row);
      }
      for (const path of paths) {
        const parsed = parsePath(path);
        columns.push({ name: path, type: types.get(path) ?? 'string', binding: 'pset' in parsed ? parsed : undefined });
      }
      return { table: { columns, rows, key: 'GlobalId' } satisfies Table };
    },
  },
  {
    type: 'table.longFormat',
    title: 'Long-format table',
    category: 'table',
    doc: 'Every property of every entity as (GlobalId, Pset, Prop, Value, Type) rows.',
    inputs: [{ name: 'entities', type: ENTITY_LIST }],
    outputs: [{ name: 'table', type: TABLE_ITEM }],
    params: [],
    capabilities: ['model.read'],
    reads: 'model',
    run: (ctx, i) => {
      requireCapability(ctx, 'model.read');
      const rows: Row[] = [];
      for (const ref of i.entities as EntityRef[]) {
        const sdkRef = toSdkRef(ctx, ref);
        for (const pset of ctx.host.bim.properties(sdkRef)) {
          for (const prop of pset.properties) {
            rows.push({ GlobalId: ref.globalId, Pset: pset.name, Prop: prop.name, Value: prop.value, Type: columnTypeOf(prop.type) });
          }
        }
      }
      const columns: Column[] = [GLOBAL_ID, { name: 'Pset', type: 'label' }, { name: 'Prop', type: 'label' }, { name: 'Value', type: 'string' }, { name: 'Type', type: 'label' }];
      return { table: { columns, rows, key: 'GlobalId' } satisfies Table };
    },
  },
  {
    type: 'table.column',
    title: 'Column',
    category: 'table',
    inputs: [{ name: 'table', type: TABLE_ITEM }],
    outputs: [{ name: 'values', type: SCALAR_LIST }],
    params: [{ name: 'column', kind: 'string', default: 'GlobalId' }],
    capabilities: [],
    run: (_c, i, p) => {
      const t = tableOf(i.table);
      const name = String(p.column);
      if (!t.columns.some((c) => c.name === name)) throw new Error(`no column "${name}"`);
      return { values: t.rows.map((r) => r[name] ?? null) };
    },
  },
  {
    type: 'table.groupRows',
    title: 'Group rows',
    category: 'table',
    doc: 'Rows under the value of a column (the key column by default); keyless rows are a separate output.',
    inputs: [{ name: 'table', type: TABLE_ITEM }],
    outputs: [
      { name: 'rows', type: ANY_GROUP },
      { name: 'unkeyed', type: { kind: 'any', access: 'list' } },
    ],
    params: [{ name: 'by', kind: 'string' }],
    capabilities: [],
    run: (_c, i, p) => {
      const t = tableOf(i.table);
      const by = typeof p.by === 'string' && p.by.length > 0 ? p.by : t.key;
      const { branches, unkeyed } = groupRows(t, by);
      return { rows: branches as Map<GroupKey, unknown[]>, unkeyed };
    },
  },
  {
    type: 'table.pivot',
    title: 'Pivot',
    category: 'table',
    doc: 'Long format → one row per key with a column per distinct value of the column-key column.',
    inputs: [{ name: 'table', type: TABLE_ITEM }],
    outputs: [
      { name: 'table', type: TABLE_ITEM },
      { name: 'duplicates', type: SCALAR_ITEM },
    ],
    params: [
      { name: 'rowKey', kind: 'string', default: 'GlobalId' },
      { name: 'columnKey', kind: 'string', default: 'Prop' },
      { name: 'value', kind: 'string', default: 'Value' },
    ],
    capabilities: [],
    run: (_c, i, p) => {
      const { table, duplicates } = pivot(tableOf(i.table), String(p.rowKey), String(p.columnKey), String(p.value));
      return { table, duplicates };
    },
  },
  {
    type: 'table.rowCount',
    title: 'Row count',
    category: 'table',
    inputs: [{ name: 'table', type: TABLE_ITEM }],
    outputs: [{ name: 'count', type: SCALAR_ITEM }],
    params: [],
    capabilities: [],
    run: (_c, i) => ({ count: tableOf(i.table).rows.length }),
  },
];
