/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Evaluates an `IfcQuerySpec` against every loaded model and resolves field
 * paths (built-ins, IFC attributes, `Pset.Prop` and `Qto.Quantity`) to values.
 * This is what makes counts and rows on a surface come from the model rather
 * than from text a language model typed.
 */

import {
  matchesCondition,
  normalizeQuery,
  parseFieldPath,
  type FieldPath,
  type IfcQuerySpec,
  type QueryCondition,
  type QueryProblem,
  type WireEntityRef,
} from '@ifc-lite/a2ui';
import type { A2uiEntity, A2uiViewerHost } from './host.js';

const lower = (s: string) => s.toLowerCase();

/**
 * Field reads for one evaluation. Property, quantity and attribute lookups are
 * cached per entity, since a table reads many columns and a filter reads every
 * candidate; drop the reader when the models change.
 */
export class FieldReader {
  private readonly cache = new Map<string, unknown[]>();

  constructor(private readonly host: A2uiViewerHost) {}

  /** Every value the path has on the entity (an entity can carry two same-named sets). */
  values(entity: A2uiEntity, path: FieldPath | string): unknown[] {
    const parsed = typeof path === 'string' ? parseFieldPath(path) : path;
    if (!parsed) return [];
    const cacheKey = `${entity.key}\u0000${typeof path === 'string' ? path : JSON.stringify(path)}`;
    const hit = this.cache.get(cacheKey);
    if (hit) return hit;
    const found = this.read(entity, parsed).filter((v) => v !== undefined && v !== null && v !== '');
    this.cache.set(cacheKey, found);
    return found;
  }

  /** The first value, or undefined. */
  value(entity: A2uiEntity, path: FieldPath | string): unknown {
    return this.values(entity, path)[0];
  }

  private read(entity: A2uiEntity, path: FieldPath): unknown[] {
    if (path.kind === 'builtin') {
      switch (path.key) {
        case 'name': return [entity.name];
        case 'globalId': return [entity.globalId];
        case 'type': return [entity.type];
        case 'description': return [entity.description];
        case 'objectType': return [entity.objectType];
        case 'modelId': return [entity.ref.modelId];
        case 'storey': return [this.host.storeyName(entity.ref)];
        case 'material': return [materialLabel(this.host, entity.ref)];
      }
    }
    if (path.kind === 'attribute') {
      const want = lower(path.name);
      return this.host.attributes(entity.ref).filter((a) => lower(a.name) === want).map((a) => a.value);
    }
    const set = lower(path.set);
    const name = lower(path.name);
    const out: unknown[] = [];
    for (const pset of this.host.properties(entity.ref)) {
      if (lower(pset.name) !== set) continue;
      for (const p of pset.properties) if (lower(p.name) === name) out.push(p.value);
    }
    // Quantity sets answer `Qto_*.Name` paths, and also `BaseQuantities.Name`.
    for (const qset of this.host.quantities(entity.ref)) {
      if (lower(qset.name) !== set) continue;
      for (const q of qset.quantities) if (lower(q.name) === name) out.push(q.value);
    }
    return out;
  }
}

function materialLabel(host: A2uiViewerHost, ref: WireEntityRef): string | undefined {
  const m = host.materials(ref);
  if (!m) return undefined;
  if (m.name) return m.name;
  const names = [
    ...(m.layers ?? []).map((l) => l.materialName ?? l.name),
    ...(m.constituents ?? []).map((c) => c.materialName ?? c.name),
    ...(m.profiles ?? []).map((p) => p.materialName ?? p.name),
    ...(m.materials ?? []).map((x) => x.name),
  ].filter((n): n is string => !!n);
  return names.length ? [...new Set(names)].join(', ') : undefined;
}

/** A condition holds when any value of the path satisfies it (missing: none present; neq: none equal). */
export function entityMatches(reader: FieldReader, entity: A2uiEntity, cond: QueryCondition): boolean {
  const values = reader.values(entity, cond.path);
  if (cond.op === 'missing') return values.length === 0;
  if (cond.op === 'exists') return values.length > 0;
  if (cond.op === 'neq') return !values.some((v) => matchesCondition(v, { ...cond, op: 'eq' }));
  if (values.length === 0) return false;
  return values.some((v) => matchesCondition(v, cond));
}

export interface QueryResult {
  spec: IfcQuerySpec;
  /** Matches up to the limit: what a table or list shows. */
  rows: A2uiEntity[];
  /** Every match, before the limit. */
  matches: A2uiEntity[];
  total: number;
  /** The query set its own limit, so aggregates honour it instead of counting every match. */
  explicitLimit: boolean;
  problems: QueryProblem[];
  /** The spec named a model that is not loaded: the result is inert, not empty. */
  unloadedModel?: string;
}

/** Evaluate an untrusted query against the loaded models. Problems are reported, never guessed around. */
export function evaluateQuery(host: A2uiViewerHost, input: unknown, reader = new FieldReader(host)): QueryResult {
  const { spec, problems } = normalizeQuery(input ?? {});
  if (spec.modelId && !host.loadedModelIds().includes(spec.modelId)) {
    return { spec, rows: [], matches: [], total: 0, explicitLimit: false, problems, unloadedModel: spec.modelId };
  }
  let rows = host.candidates(spec.types, spec.modelId);
  if (spec.storey) {
    const storey = lower(spec.storey);
    rows = rows.filter((e) => reader.values(e, 'storey').some((v) => lower(String(v)) === storey));
  }
  for (const cond of spec.where ?? []) rows = rows.filter((e) => entityMatches(reader, e, cond));
  const explicitLimit = typeof (input as { limit?: unknown } | null)?.limit === 'number';
  return { spec, rows: rows.slice(0, spec.limit), matches: rows, total: rows.length, explicitLimit, problems };
}

/** What an aggregate (stat, chart, legend, sum) runs over: every match unless the query set a limit. */
export function aggregatePool(result: QueryResult): A2uiEntity[] {
  return result.explicitLimit ? result.rows : result.matches;
}

/** Numeric reading of a field value (quantities are numbers, properties may be numeric strings). */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export type Aggregate = 'count' | 'sum' | 'avg' | 'min' | 'max';

/** Aggregate a numeric path over rows. Rows without a number are skipped (count counts rows). */
export function aggregate(reader: FieldReader, rows: A2uiEntity[], kind: Aggregate, path?: string): number | undefined {
  if (kind === 'count') return rows.length;
  if (!path) return undefined;
  const nums = rows.map((r) => toNumber(reader.value(r, path))).filter((n): n is number => n !== undefined);
  if (nums.length === 0) return undefined;
  switch (kind) {
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min': return Math.min(...nums);
    case 'max': return Math.max(...nums);
  }
}

export interface Group {
  label: string;
  rows: A2uiEntity[];
  value: number;
}

/** Group rows by a field path (missing values group under `emptyLabel`), largest first. */
export function groupRows(
  reader: FieldReader,
  rows: A2uiEntity[],
  by: string,
  emptyLabel: string,
  measure: { kind: 'count' } | { kind: 'sum'; path: string } = { kind: 'count' },
): Group[] {
  const groups = new Map<string, A2uiEntity[]>();
  for (const row of rows) {
    const v = reader.value(row, by);
    const label = v === undefined ? emptyLabel : String(v);
    const list = groups.get(label);
    if (list) list.push(row);
    else groups.set(label, [row]);
  }
  return [...groups].map(([label, members]) => ({
    label,
    rows: members,
    value: measure.kind === 'count' ? members.length : aggregate(reader, members, 'sum', measure.path) ?? 0,
  })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}
