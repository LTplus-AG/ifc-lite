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
const SCORE = {
  GUID_EXACT: 1000,
  NAME_EXACT: 500,
  NAME_PREFIX: 100,
  TYPE_EXACT: 80,
  TYPE_PREFIX: 60,
  NAME_SUBSTR: 40,
  OBJECTTYPE_SUBSTR: 20,
  DESCRIPTION_SUBSTR: 10,
} as const;

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
  const needle = trimmed.toLowerCase();

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
          typeName: table.getTypeName(exactExpressId),
          name: table.getName(exactExpressId),
          globalId: trimmed,
          description: table.getDescription(exactExpressId),
          objectType: table.getObjectType(exactExpressId),
          matchField: 'globalId',
          score: SCORE.GUID_EXACT,
        });
      }
    }

    scanModel(model.id, store, needle, options.maxScanPerModel, collected);
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
  needle: string,
  maxScan: number | undefined,
  out: SearchResult[],
): void {
  const table = store.entities;
  const strings = store.strings;
  const count = table.count;
  const cap = maxScan != null ? Math.min(count, maxScan) : count;

  // Direct typed-array references — avoids per-row method-call overhead.
  const expressId = table.expressId;
  const nameIdx = table.name;
  const globalIdIdx = table.globalId;
  const descriptionIdx = table.description;
  const objectTypeIdx = table.objectType;

  for (let i = 0; i < cap; i++) {
    // Fast skip: rows where every searchable string slot is the empty
    // string (StringTable index 0) — common for non-geometry entities
    // that the parser never batch-extracted. This keeps 4M-entity scans
    // O(populated rows) in practice.
    const nIdx = nameIdx[i];
    const gIdx = globalIdIdx[i];
    const dIdx = descriptionIdx[i];
    const oIdx = objectTypeIdx[i];
    if (nIdx === 0 && gIdx === 0 && dIdx === 0 && oIdx === 0) continue;

    const name = nIdx !== 0 ? strings.get(nIdx) : '';
    const globalId = gIdx !== 0 ? strings.get(gIdx) : '';

    // Score every applicable field and keep the max — Tier-1's
    // `scoreEntry` does the same, and the result-merge code in the UI
    // depends on Tier-0 / Tier-1 producing comparable orderings. The
    // previous short-circuit (skip type once name produced any score)
    // ranked an entity that hits NAME_SUBSTR (40) below an entity that
    // would have hit TYPE_EXACT (80) on its name field, so the same
    // logical match scored differently across paths.
    let score = 0;
    let matchField: MatchField = 'name';
    const bump = (s: number, mf: MatchField): void => {
      if (s > score) {
        score = s;
        matchField = mf;
      }
    };

    if (name) {
      const nameLower = name.toLowerCase();
      if (nameLower === needle) bump(SCORE.NAME_EXACT, 'name');
      else if (nameLower.startsWith(needle)) bump(SCORE.NAME_PREFIX, 'name');
      else if (nameLower.includes(needle)) bump(SCORE.NAME_SUBSTR, 'name');
    }

    {
      // Type lookup uses the resolved type-name accessor (handles enum
      // → PascalCase conversion). Cheap but a method call, so it stays
      // inside the per-row loop only because it can outrank NAME_SUBSTR.
      const typeName = table.getTypeName(expressId[i]);
      const typeLower = typeName.toLowerCase();
      if (typeLower === needle) bump(SCORE.TYPE_EXACT, 'type');
      else if (typeLower.startsWith(needle)) bump(SCORE.TYPE_PREFIX, 'type');
    }

    let objectType = '';
    if (oIdx !== 0) {
      objectType = strings.get(oIdx);
      if (objectType.toLowerCase().includes(needle)) {
        bump(SCORE.OBJECTTYPE_SUBSTR, 'objectType');
      }
    }

    let description = '';
    if (dIdx !== 0) {
      description = strings.get(dIdx);
      if (description.toLowerCase().includes(needle)) {
        bump(SCORE.DESCRIPTION_SUBSTR, 'description');
      }
    }

    if (score === 0) continue;

    // Resolve remaining display fields lazily so non-matches stay cheap.
    const id = expressId[i];
    out.push({
      modelId,
      expressId: id,
      typeName: table.getTypeName(id),
      name,
      globalId,
      description: description || (dIdx !== 0 ? strings.get(dIdx) : ''),
      objectType: objectType || (oIdx !== 0 ? strings.get(oIdx) : ''),
      matchField,
      score,
    });
  }
}
