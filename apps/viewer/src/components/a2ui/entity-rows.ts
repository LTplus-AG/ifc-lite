/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Row model shared by EntityTable and EntityList: rows from a live query or
 * from script rows bound in the data model, sorted (numeric-aware) and grouped.
 */

import { parseRef, type WireEntityRef } from '@ifc-lite/a2ui';
import type { A2uiViewerHost } from '@/lib/a2ui/host';
import { toNumber, type FieldReader, type QueryResult } from '@/lib/a2ui/query-eval';

export interface Column {
  path: string;
  label?: string;
}

export function isColumn(value: unknown): value is Column {
  const c = value as Partial<Column> | null;
  return !!c && typeof c.path === 'string' && c.path.length > 0 && (c.label === undefined || typeof c.label === 'string');
}

export interface EntityRow {
  /** Stable React key: the ref when there is one. */
  key: string;
  ref?: WireEntityRef;
  /** False for a ref whose model is not loaded: shown, but inert. */
  live: boolean;
  label: string;
  /** Read a column (or group-by) path for this row. */
  read: (path: string) => unknown;
}

export function rowsFromQuery(result: QueryResult, reader: FieldReader, labelPath = 'name'): EntityRow[] {
  return result.rows.map((entity) => ({
    key: entity.key,
    ref: entity.ref,
    live: true,
    label: String(reader.value(entity, labelPath) ?? entity.name ?? entity.key),
    read: (path) => reader.value(entity, path),
  }));
}

/**
 * Script rows: `{ref, ...values}`. A value the row carries wins; a path it
 * does not carry is read live from the model when the row has a loaded ref.
 */
export function rowsFromData(data: unknown, host: A2uiViewerHost, reader: FieldReader, labelPath = 'name'): { rows: EntityRow[]; unloadedModels: string[] } {
  const list = Array.isArray(data) ? data : [];
  const loaded = new Set(host.loadedModelIds());
  const unloaded = new Set<string>();
  const rows = list.flatMap((item, index): EntityRow[] => {
    const record = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : typeof item === 'string' ? { ref: item } : null;
    if (!record) return [];
    const ref = parseRef(record.ref) ?? undefined;
    const live = !!ref && loaded.has(ref.modelId);
    if (ref && !live) unloaded.add(ref.modelId);
    const entity = live && ref ? host.entity(ref) : null;
    const read = (path: string): unknown => (Object.hasOwn(record, path) ? record[path] : entity ? reader.value(entity, path) : undefined);
    const label = read(labelPath) ?? record.label ?? record.ref ?? `#${index + 1}`;
    return [{ key: typeof record.ref === 'string' ? `${record.ref}#${index}` : `row-${index}`, ref, live, label: String(label), read }];
  });
  return { rows, unloadedModels: [...unloaded] };
}

/** Refs from a bound list of `"modelId:expressId"` strings. */
export function rowsFromRefs(refs: unknown, host: A2uiViewerHost, reader: FieldReader, labelPath = 'name'): { rows: EntityRow[]; unloadedModels: string[] } {
  return rowsFromData(Array.isArray(refs) ? refs.filter((r) => typeof r === 'string') : [], host, reader, labelPath);
}

export type SortDir = 'asc' | 'desc';
export interface SortState {
  path: string;
  dir: SortDir;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Compare cell values: numbers numerically, text naturally; empty cells always last. */
export function compareValues(a: unknown, b: unknown, dir: SortDir): number {
  const aEmpty = a === undefined || a === null || a === '';
  const bEmpty = b === undefined || b === null || b === '';
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  const an = toNumber(a);
  const bn = toNumber(b);
  const sign = dir === 'asc' ? 1 : -1;
  if (an !== undefined && bn !== undefined) return (an - bn) * sign;
  return collator.compare(String(a), String(b)) * sign;
}

export function sortRows(rows: EntityRow[], sort: SortState | null): EntityRow[] {
  if (!sort) return rows;
  return rows.map((row, i) => ({ row, i, v: row.read(sort.path) }))
    .sort((x, y) => compareValues(x.v, y.v, sort.dir) || x.i - y.i)
    .map((x) => x.row);
}

export interface RowGroup {
  label: string;
  rows: EntityRow[];
}

export function groupEntityRows(rows: EntityRow[], by: string | undefined, emptyLabel: string): RowGroup[] {
  if (!by) return [{ label: '', rows }];
  const groups = new Map<string, EntityRow[]>();
  for (const row of rows) {
    const v = row.read(by);
    const label = v === undefined || v === null || v === '' ? emptyLabel : String(v);
    const list = groups.get(label);
    if (list) list.push(row);
    else groups.set(label, [row]);
  }
  return [...groups].map(([label, members]) => ({ label, rows: members }));
}

/** Normalise the `sort` prop; anything malformed means unsorted. */
export function initialSort(sort: unknown): SortState | null {
  if (!sort || typeof sort !== 'object') return null;
  const s = sort as { path?: unknown; dir?: unknown };
  if (typeof s.path !== 'string' || !s.path) return null;
  return { path: s.path, dir: s.dir === 'desc' ? 'desc' : 'asc' };
}

/** Header click: a new column sorts ascending; the same column flips. */
export function nextSort(current: SortState | null, path: string): SortState {
  if (current?.path === path) return { path, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { path, dir: 'asc' };
}
