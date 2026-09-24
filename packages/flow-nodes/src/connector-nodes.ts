/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `table.joinByKey` — join spreadsheet rows to model entities by a key
 * (issue #5167 phase 3.2, the pilot workflow's second step). `tag` and
 * `property` reuse `@ifc-lite/mutations`' `csv-match.ts` index builder
 * (`buildMatchContext`/`matchRowAgainstContext`, merged in #5230) rather
 * than re-implementing matching — see `host.ts`'s `TableAccess` for why that
 * needs a bulk entity-table accessor most hosts do not have to provide.
 * `globalId`/`name` are matched directly over the candidate `entities` list,
 * which is already small (whatever an upstream selector narrowed it to) and
 * does not need the whole-model index.
 *
 * Ambiguity is reported in BOTH directions, never resolved to the first
 * match: a row naming a value several candidate entities carry, and an
 * entity two different rows both uniquely claim.
 */

import { buildMatchContext, matchRowAgainstContext, type CsvRow, type MatchStrategy } from '@ifc-lite/mutations';
import type { Column, EntityRef, Row, Table } from '@ifc-lite/flow';
import { ENTITY_LIST, TABLE_ITEM, entityOf, requireCapability, toSdkRef, type Ctx, type FlowNodeDef } from './host.js';
import { tableOf } from './table-nodes.js';

const JOIN_STRATEGIES = ['globalId', 'tag', 'name', 'property'] as const;
type JoinStrategy = (typeof JOIN_STRATEGIES)[number];

function isJoinStrategy(v: unknown): v is JoinStrategy {
  return typeof v === 'string' && (JOIN_STRATEGIES as readonly string[]).includes(v);
}

interface Candidate {
  readonly ref: EntityRef;
  /** The model the express id belongs to — express ids are per-model. */
  readonly modelId: string;
  readonly expressId: number;
}

/** globalId/name candidate index, built once over the (small) input pool. */
function directIndex(ctx: Ctx, candidates: readonly Candidate[], strategy: 'globalId' | 'name'): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const c of candidates) {
    const key = strategy === 'globalId' ? c.ref.globalId : entityOf(ctx, c.ref).name.toLowerCase();
    if (!key) continue;
    const list = index.get(key);
    if (list) list.push(c.ref.globalId);
    else index.set(key, [c.ref.globalId]);
  }
  return index;
}

/** The GlobalId of every distinct entity a row matches, restricted to the candidate pool. */
function matchedGlobalIdsFor(
  ctx: Ctx,
  t: Table,
  candidates: readonly Candidate[],
  strategy: JoinStrategy,
  column: string,
  pset: string,
  prop: string,
): { perRow: string[][]; problems: string[] } {
  const problems: string[] = [];

  if (strategy === 'globalId' || strategy === 'name') {
    const index = directIndex(ctx, candidates, strategy);
    const perRow = t.rows.map((row, i) => {
      const raw = row[column];
      if (raw === null || raw === undefined || raw === '') {
        problems.push(`row ${i}: empty match value in column "${column}"`);
        return [];
      }
      const key = strategy === 'name' ? String(raw).toLowerCase() : String(raw);
      return index.get(key) ?? [];
    });
    return { perRow, problems };
  }

  // tag / property: reuse csv-match.ts's whole-model index, then restrict the
  // result to the candidate pool by express id. Express ids are PER MODEL, so
  // each model's candidates are matched against that model's own table: one
  // shared table would let a local id in the active model resolve to a
  // same-numbered candidate in another model and write to the wrong entity.
  const byModel = new Map<string, Map<number, string>>();
  for (const candidate of candidates) {
    let pool = byModel.get(candidate.modelId);
    if (!pool) byModel.set(candidate.modelId, (pool = new Map()));
    pool.set(candidate.expressId, candidate.ref.globalId);
  }
  const csvRows: CsvRow[] = t.rows.map((row) => ({ [column]: row[column] === null || row[column] === undefined ? '' : String(row[column]) }));
  const matchStrategy: MatchStrategy = strategy === 'tag' ? { type: 'tag', column } : { type: 'property', psetName: pset, propName: prop, column };
  // Keyed by the entity (model + express id), not its GlobalId: two models
  // can hold distinct entities under one GlobalId, and collapsing them to one
  // string reported a row matching both as a unique match (#5377 review).
  const perRow: Array<Map<string, string>> = csvRows.map(() => new Map<string, string>());
  const firstModelId = [...byModel.keys()][0];
  for (const [modelId, pool] of byModel) {
    const access = ctx.host.tables?.(modelId);
    if (!access) {
      throw new Error(`table.joinByKey: strategy "${strategy}" needs a host that provides bulk entity access (host.tables) for model "${modelId}"; this host does not`);
    }
    const matchContext = buildMatchContext(access.entities, access.mutationView, access.strings, matchStrategy, csvRows);
    csvRows.forEach((row, i) => {
      const result = matchRowAgainstContext(row, i, matchStrategy, matchContext);
      // A warning is about the row, not the model: report it once.
      if (modelId === firstModelId) problems.push(...(result.warnings ?? []).map((w) => `row ${i}: ${w}`));
      for (const expressId of result.matchedEntityIds) {
        const gid = pool.get(expressId);
        if (gid) perRow[i].set(`${modelId}#${expressId}`, gid);
      }
    });
  }
  return { perRow: perRow.map((ids) => [...ids.values()]), problems };
}

function withColumn(columns: readonly Column[], col: Column): Column[] {
  const idx = columns.findIndex((c) => c.name === col.name);
  if (idx === -1) return [...columns, col];
  const out = [...columns];
  out[idx] = col;
  return out;
}

export const connectorNodes: FlowNodeDef[] = [
  {
    type: 'table.joinByKey',
    title: 'Join by key',
    category: 'table',
    doc: 'Joins table rows to entities by GlobalId, Tag, Name, or an indexed property. Ambiguous rows (matching several entities) and ambiguous entities (claimed by several rows) are reported separately, never resolved to the first match.',
    inputs: [
      { name: 'entities', type: ENTITY_LIST },
      { name: 'table', type: TABLE_ITEM },
    ],
    outputs: [
      { name: 'matched', type: TABLE_ITEM },
      { name: 'unmatched', type: TABLE_ITEM },
      { name: 'ambiguous', type: TABLE_ITEM },
    ],
    params: [
      { name: 'strategy', kind: 'enum', default: 'globalId', options: [...JOIN_STRATEGIES] },
      { name: 'column', kind: 'string', default: 'GlobalId' },
      { name: 'pset', kind: 'string', default: '' },
      { name: 'prop', kind: 'string', default: '' },
    ],
    capabilities: ['model.read'],
    reads: 'model',
    run: (ctx, i, p) => {
      requireCapability(ctx, 'model.read');
      const t = tableOf(i.table);
      const strategy = isJoinStrategy(p.strategy) ? p.strategy : 'globalId';
      const column = typeof p.column === 'string' && p.column.length > 0 ? p.column : 'GlobalId';
      if (!t.columns.some((c) => c.name === column)) throw new Error(`table.joinByKey: no column "${column}"`);
      if (strategy === 'property' && (!p.pset || !p.prop)) throw new Error('table.joinByKey: strategy "property" needs both "pset" and "prop" params');

      // One candidate per entity: the same entity listed twice is not two
      // matches, so it must not make a row ambiguous.
      const seen = new Set<string>();
      const candidates: Candidate[] = [];
      for (const ref of i.entities as EntityRef[]) {
        const address = toSdkRef(ctx, ref);
        const identity = `${address.modelId}#${address.expressId}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        candidates.push({ ref, modelId: address.modelId, expressId: address.expressId });
      }
      const { perRow, problems } = matchedGlobalIdsFor(ctx, t, candidates, strategy, column, String(p.pset ?? ''), String(p.prop ?? ''));
      for (const msg of problems) ctx.log('warn', msg);

      // Entity-side ambiguity: an entity two DIFFERENT rows both uniquely claim.
      const byEntity = new Map<string, number[]>();
      perRow.forEach((globalIds, rowIdx) => {
        if (globalIds.length === 1) {
          const list = byEntity.get(globalIds[0]);
          if (list) list.push(rowIdx);
          else byEntity.set(globalIds[0], [rowIdx]);
        }
      });
      const entityAmbiguous = new Set<number>();
      for (const rowIdxs of byEntity.values()) {
        if (rowIdxs.length > 1) for (const idx of rowIdxs) entityAmbiguous.add(idx);
      }

      const matchedRows: Row[] = [];
      const unmatchedRows: Row[] = [];
      const ambiguousRows: Row[] = [];
      t.rows.forEach((row, idx) => {
        const globalIds = perRow[idx];
        if (globalIds.length === 0) {
          unmatchedRows.push(row);
        } else if (globalIds.length > 1 || entityAmbiguous.has(idx)) {
          ambiguousRows.push({ ...row, MatchedGlobalIds: globalIds.join(';') });
        } else {
          matchedRows.push({ ...row, GlobalId: globalIds[0] });
        }
      });

      const matchedColumns = withColumn(t.columns, { name: 'GlobalId', type: 'identifier' });
      const matched: Table = { columns: matchedColumns, rows: matchedRows, key: 'GlobalId' };
      const unmatched: Table = { columns: t.columns, rows: unmatchedRows, key: t.key };
      const ambiguousColumns = withColumn(t.columns, { name: 'MatchedGlobalIds', type: 'string' });
      const ambiguous: Table = { columns: ambiguousColumns, rows: ambiguousRows, key: t.key };
      return { matched, unmatched, ambiguous };
    },
  },
];
