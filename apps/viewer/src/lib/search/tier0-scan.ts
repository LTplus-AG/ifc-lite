/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tier-0 search scan: linear pass over EntityTable columns that are
 * ALREADY POPULATED during normal IFC parsing. Adds zero work to the
 * load hot path — `name` and `globalId` are batch-extracted by the
 * parser for geometry entities + types via `batchExtractGlobalIdAndName`,
 * and we read them straight out of the columnar TypedArrays.
 *
 * Crucially: this never calls `extractEntityAttributesOnDemand` (see
 * AGENTS.md §2). Empty-string rows are skipped via O(1) checks against
 * the StringTable index 0 (which is the canonical empty string).
 *
 * Tier-1 (worker-built inverted index) and Tier-3 (DuckDB SQL) layer
 * on top of the same `SearchResult` shape in later phases.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { SCORE, prepareSearchQuery, resolveModelMatches, rowTokenHits, substringMatch, type RowMatch, type SearchQuery, type SearchRowText } from './search-match.js';

/** A federated model carries its IFC store + an offset into the global ID space. */
export interface ScanModel {
  id: string;
  ifcDataStore: IfcDataStore | null;
}

export type MatchField = 'globalId' | 'name' | 'type' | 'description' | 'objectType';

export interface SearchResult {
  modelId: string;
  /** Local express ID inside the source model — federation conversion happens in the UI layer. */
  expressId: number;
  typeName: string;
  name: string;
  globalId: string;
  description: string;
  objectType: string;
  /** Field that produced the highest score for this entity. */
  matchField: MatchField;
  score: number;
}

export interface ScanOptions {
  /** Maximum results returned (sorted by descending score). Default 50. */
  limit?: number;
  /** If set, abort after this many entities scanned per model (perf safety). */
  maxScanPerModel?: number;
}

const DEFAULT_LIMIT = 50;

/** Scoring weights — higher = better. Stable enough that downstream UI can compare. */
// Scores and the match rule are tier-1's (search-match.ts), so results do not change when the index takes over.

/**
 * Run a Tier-0 search across one or more models.
 *
 * Returns up to `limit` results sorted by descending score, then by
 * (modelId, expressId) for stable ordering. Empty/whitespace queries
 * return an empty array — the caller should not even open the popover.
 */
export function runTier0Scan(
  models: readonly ScanModel[],
  query: string,
  options: ScanOptions = {},
): SearchResult[] {
  const trimmed = query.trim();
  if (trimmed.length < 1) return [];

  const limit = options.limit ?? DEFAULT_LIMIT;
  const prepared = prepareSearchQuery(trimmed);

  // GUID exact-match fast path — IFC GlobalIds are 22-char base64-like strings.
  // We test the trimmed (case-sensitive) form because GUIDs are case-sensitive.
  const looksLikeGuid = trimmed.length === 22 && /^[A-Za-z0-9_$]{22}$/.test(trimmed);

  const collected: SearchResult[] = [];

  for (const model of models) {
    const store = model.ifcDataStore;
    if (!store) continue;
    const table = store.entities;
    if (!table || table.count === 0) continue;

    // GUID fast path: O(1) lookup, push and continue (still scan others
    // for additional substring matches, but skip the row-level pass for
    // this particular GUID).
    if (looksLikeGuid) {
      const exactExpressId = table.getExpressIdByGlobalId(trimmed);
      if (exactExpressId > 0) {
        collected.push({
          modelId: model.id,
          expressId: exactExpressId,
          typeName: table.getTypeName(exactExpressId) ?? '',
          name: table.getName(exactExpressId),
          globalId: trimmed,
          description: table.getDescription(exactExpressId),
          objectType: table.getObjectType(exactExpressId),
          matchField: 'globalId',
          score: SCORE.GUID_EXACT,
        });
      }
    }

    scanModel(model.id, store, prepared, options.maxScanPerModel, collected);
  }

  // Stable sort: score desc, then modelId asc, then expressId asc.
  collected.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.modelId !== b.modelId) return a.modelId < b.modelId ? -1 : 1;
    return a.expressId - b.expressId;
  });

  // Dedupe — the GUID fast path may have added a row that the linear pass
  // also matched. Keep the highest-scoring instance per (modelId, expressId).
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of collected) {
    const key = `${r.modelId}:${r.expressId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

function scanModel(
  modelId: string,
  store: IfcDataStore,
  query: SearchQuery,
  maxScan: number | undefined,
  out: SearchResult[],
): void {
  const table = store.entities;
  const strings = store.strings;
  const count = table.count;
  const cap = maxScan != null ? Math.min(count, maxScan) : count;
  const expressId = table.expressId;
  const nameIdx = table.name;
  const globalIdIdx = table.globalId;
  const descriptionIdx = table.description;
  const objectTypeIdx = table.objectType;
  const lower = lowerStrings(strings);
  // One reused view: the shared rule reads a row's text only while scoring it.
  const view: SearchRowText = { nameLower: '', typeNameLower: '', descriptionLower: '', objectTypeLower: '' };
  const text = (row: number): SearchRowText => {
    view.nameLower = lower(nameIdx[row]);
    view.typeNameLower = lowerType(table.getTypeName(expressId[row]) ?? '');
    view.descriptionLower = lower(descriptionIdx[row]);
    view.objectTypeLower = lower(objectTypeIdx[row]);
    return view;
  };

  // One pass: candidates (rule 1) and, when the query allows a sweep, every
  // row's substring match (used only if the model has no candidate, rule 3).
  const candidates = new Map<number, number>();
  const swept: [number, RowMatch][] = [];
  for (let i = 0; i < cap; i++) {
    // The rows tier-1 indexes: those with any searchable string slot.
    if (nameIdx[i] === 0 && globalIdIdx[i] === 0 && descriptionIdx[i] === 0 && objectTypeIdx[i] === 0) continue;
    const row = text(i);
    const hits = query.tokens.length > 0 ? rowTokenHits(row, query.tokens) : 0;
    if (hits > 0) candidates.set(i, hits);
    else if (query.sweep && candidates.size === 0) {
      const match = substringMatch(row, query.needle);
      if (match) swept.push([i, match]);
    }
  }
  for (const [i, m] of resolveModelMatches(candidates, () => swept, text, query)) {
    const id = expressId[i];
    const nIdx = nameIdx[i], gIdx = globalIdIdx[i], dIdx = descriptionIdx[i], oIdx = objectTypeIdx[i];
    out.push({
      modelId,
      expressId: id,
      typeName: table.getTypeName(id) ?? '',
      name: nIdx !== 0 ? strings.get(nIdx) : '',
      globalId: gIdx !== 0 ? strings.get(gIdx) : '',
      description: dIdx !== 0 ? strings.get(dIdx) : '',
      objectType: oIdx !== 0 ? strings.get(oIdx) : '',
      matchField: m.matchField,
      score: m.score,
    });
  }
}

/** Lower-cased string-table entries, cached per table: the scan runs on every keystroke. */
const LOWER_STRINGS = new WeakMap<object, Map<number, string>>();
function lowerStrings(strings: IfcDataStore['strings']): (index: number) => string {
  let cache = LOWER_STRINGS.get(strings);
  if (!cache) LOWER_STRINGS.set(strings, (cache = new Map()));
  const c = cache;
  return (index) => {
    if (index === 0) return '';
    let v = c.get(index);
    if (v === undefined) c.set(index, (v = strings.get(index).toLowerCase()));
    return v;
  };
}

const LOWER_TYPES = new Map<string, string>();
function lowerType(typeName: string): string {
  let v = LOWER_TYPES.get(typeName);
  if (v === undefined) LOWER_TYPES.set(typeName, (v = typeName.toLowerCase()));
  return v;
}
