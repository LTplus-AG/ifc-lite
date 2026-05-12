/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tier-1 search index — a per-model inverted token index built AFTER
 * the IFC load completes (triggered by useSearchIndex once the store
 * is present). Zero work on the load hot path; the build itself yields
 * to the event loop every `chunkSize` rows via MessageChannel so a
 * 4M-entity index never blocks input.
 *
 * Tier-1 replaces the Tier-0 linear scan transparently for any model
 * that has finished indexing. Models still being indexed (or models
 * that lost their index) fall back to Tier-0 without any caller
 * awareness — see `SearchInline`.
 *
 * Indexed fields (all already materialised in EntityTable by the
 * parser — no on-demand extraction is ever triggered):
 *   - name, globalId, description, objectType, IFC type name
 *
 * Tokenisation splits on whitespace AND the punctuation common in IFC
 * names (`-`, `_`, `.`, `/`, `:`) so "Wall-EXT-001" and "Pset_WallCommon"
 * break into useful tokens.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { SearchResult, MatchField } from './tier0-scan.js';

export interface Tier1IndexEntry {
  /** Row index in the original EntityTable. */
  rowIndex: number;
  expressId: number;
  typeEnum: number;
  /** IFC type name resolved once at build time (e.g. "IfcWall"). */
  typeName: string;
  typeNameLower: string;
  name: string;
  nameLower: string;
  globalId: string;
  description: string;
  descriptionLower: string;
  objectType: string;
  objectTypeLower: string;
}

export interface Tier1Index {
  modelId: string;
  /** Sparse — populated rows only (same empty-row filter as Tier-0). */
  entries: Tier1IndexEntry[];
  /** token → indexes into `entries`; values are Uint32Arrays to avoid GC churn. */
  tokenIndex: Map<string, Uint32Array>;
  /** Sorted unique token list for prefix range queries (binary search). */
  sortedTokens: string[];
  /** GlobalId exact lookup → index into `entries`. Case-sensitive (IFC GUIDs are). */
  globalIdMap: Map<string, number>;
  /** Total entity count in the source store (for diagnostics, not query). */
  sourceEntityCount: number;
  /** Wall-clock build duration in ms. */
  buildTimeMs: number;
}

export interface BuildTier1IndexOptions {
  /** Rows per yield point. Default 20_000 — ~3 yields for a 147K model, ~220 for 4.4M. */
  chunkSize?: number;
  /** Abort the build early (e.g. model was removed or replaced). */
  signal?: AbortSignal;
  /** Optional progress callback — called after each chunk. Cheap observer only. */
  onProgress?: (done: number, total: number) => void;
}

const DEFAULT_CHUNK_SIZE = 20_000;

// Same scoring ladder as Tier-0 so result ordering between the two tiers
// stays comparable while a multi-model search straddles both paths.
const SCORE = {
  GUID_EXACT: 1000,
  NAME_EXACT: 500,
  NAME_PREFIX: 100,
  TYPE_EXACT: 80,
  TYPE_PREFIX: 60,
  NAME_SUBSTR: 40,
  OBJECTTYPE_SUBSTR: 20,
  DESCRIPTION_SUBSTR: 10,
  TOKEN_MATCH: 70,
} as const;

const TOKEN_SPLIT = /[\s\-_./:]+/;

function tokenize(value: string): string[] {
  if (!value) return [];
  const out: string[] = [];
  const parts = value.toLowerCase().split(TOKEN_SPLIT);
  for (const p of parts) {
    // Skip empty fragments and one-char tokens that aren't digits. One-char
    // letters produce ~O(entities) postings with essentially no selectivity,
    // inflating the index for no query benefit.
    if (p.length === 0) continue;
    if (p.length === 1 && !/\d/.test(p)) continue;
    out.push(p);
  }
  return out;
}

/** Yield control back to the event loop between chunks.
 *
 *  Mirrors the pattern used by `packages/parser/src/columnar-parser.ts`
 *  but closes the MessageChannel ports in the fallback path — an unclosed
 *  port keeps Node's event loop alive and hangs the test runner on
 *  shutdown. `scheduler.yield` (when present) and `setImmediate` (Node)
 *  don't have this problem.
 */
function yieldToEventLoop(): Promise<void> {
  const maybeScheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (typeof maybeScheduler?.yield === 'function') {
    return maybeScheduler.yield();
  }
  if (typeof setImmediate === 'function') {
    return new Promise<void>((resolve) => {
      setImmediate(() => resolve());
    });
  }
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/**
 * Build a Tier-1 index over one model. Runs on the main thread but yields
 * between chunks so input latency stays below ~16 ms per yield point.
 *
 * Must only be called AFTER `store` is fully populated (i.e. the model's
 * `ifcDataStore` is non-null in the viewer store). Calling during the load
 * phase is a bug — the caller should gate on the model-ready event.
 */
export async function buildTier1Index(
  modelId: string,
  store: IfcDataStore,
  options: BuildTier1IndexOptions = {},
): Promise<Tier1Index> {
  const start = performance.now();
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const signal = options.signal;
  const onProgress = options.onProgress;

  const table = store.entities;
  const strings = store.strings;
  const count = table.count;

  const expressIdCol = table.expressId;
  const typeEnumCol = table.typeEnum;
  const nameCol = table.name;
  const globalIdCol = table.globalId;
  const descriptionCol = table.description;
  const objectTypeCol = table.objectType;

  const entries: Tier1IndexEntry[] = [];
  // Build token postings as number[] arrays then freeze each to Uint32Array
  // at the end — avoids a growing Uint32Array copy per insertion.
  const pending = new Map<string, number[]>();
  const globalIdMap = new Map<string, number>();

  for (let start = 0; start < count; start += chunkSize) {
    if (signal?.aborted) {
      throw new DOMException('buildTier1Index aborted', 'AbortError');
    }
    const end = Math.min(start + chunkSize, count);
    for (let i = start; i < end; i++) {
      const nIdx = nameCol[i];
      const gIdx = globalIdCol[i];
      const dIdx = descriptionCol[i];
      const oIdx = objectTypeCol[i];
      // Same empty-row shortcut as Tier-0: rows with no searchable string
      // slot at all are skipped entirely.
      if (nIdx === 0 && gIdx === 0 && dIdx === 0 && oIdx === 0) continue;

      const expressId = expressIdCol[i];
      const name = nIdx !== 0 ? strings.get(nIdx) : '';
      const globalId = gIdx !== 0 ? strings.get(gIdx) : '';
      const description = dIdx !== 0 ? strings.get(dIdx) : '';
      const objectType = oIdx !== 0 ? strings.get(oIdx) : '';
      const typeName = table.getTypeName(expressId);

      const entryIndex = entries.length;
      entries.push({
        rowIndex: i,
        expressId,
        typeEnum: typeEnumCol[i],
        typeName,
        typeNameLower: typeName.toLowerCase(),
        name,
        nameLower: name.toLowerCase(),
        globalId,
        description,
        descriptionLower: description.toLowerCase(),
        objectType,
        objectTypeLower: objectType.toLowerCase(),
      });

      if (globalId) globalIdMap.set(globalId, entryIndex);

      // Insert all tokens from name, type, description, objectType — NOT
      // globalId (GUIDs are opaque 22-char strings; token-matching them
      // just bloats the index).
      const seen = new Set<string>();
      const addTokens = (s: string) => {
        for (const t of tokenize(s)) {
          if (seen.has(t)) continue;
          seen.add(t);
          let list = pending.get(t);
          if (!list) {
            list = [];
            pending.set(t, list);
          }
          list.push(entryIndex);
        }
      };
      addTokens(name);
      addTokens(typeName);
      addTokens(description);
      addTokens(objectType);
    }

    onProgress?.(end, count);
    if (end < count) await yieldToEventLoop();
  }

  const tokenIndex = new Map<string, Uint32Array>();
  for (const [token, list] of pending) {
    tokenIndex.set(token, Uint32Array.from(list));
  }
  const sortedTokens = Array.from(tokenIndex.keys()).sort();

  return {
    modelId,
    entries,
    tokenIndex,
    sortedTokens,
    globalIdMap,
    sourceEntityCount: count,
    buildTimeMs: performance.now() - start,
  };
}

/** Binary-search the sorted-tokens array for all tokens starting with `prefix`.
 *  Returns the half-open range [lo, hi) in `sortedTokens`. */
function prefixRange(sortedTokens: readonly string[], prefix: string): [number, number] {
  if (!prefix) return [0, 0];
  let lo = 0;
  let hi = sortedTokens.length;
  // Lower bound — first index with sortedTokens[i] >= prefix.
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedTokens[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;
  // Upper bound — first index with sortedTokens[i] NOT starting with prefix.
  hi = sortedTokens.length;
  let end = start;
  // Bump the last char of `prefix` by one to find the first token past the
  // prefix range. Works for any code point short of U+FFFF.
  const bump = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  let l = start;
  while (l < hi) {
    const mid = (l + hi) >>> 1;
    if (sortedTokens[mid] < bump) l = mid + 1;
    else hi = mid;
  }
  end = l;
  return [start, end];
}

interface ScoredCandidate {
  entryIndex: number;
  score: number;
  matchField: MatchField;
}

/**
 * Query one or more Tier-1 indexes. Results from all indexes are merged,
 * deduped, sorted by descending score, and capped at `limit`. The shape
 * matches `runTier0Scan` so `SearchInline` can concatenate Tier-0 and
 * Tier-1 result streams without a converter.
 */
export function queryTier1Indexes(
  indexes: Iterable<Tier1Index>,
  query: string,
  options: { limit?: number } = {},
): SearchResult[] {
  const trimmed = query.trim();
  if (trimmed.length < 1) return [];
  const limit = options.limit ?? 50;
  const needle = trimmed.toLowerCase();
  const queryTokens = tokenize(trimmed);
  const looksLikeGuid = trimmed.length === 22 && /^[A-Za-z0-9_$]{22}$/.test(trimmed);

  const results: SearchResult[] = [];

  for (const index of indexes) {
    const scored = scoreOneIndex(index, trimmed, needle, queryTokens, looksLikeGuid);
    for (const c of scored) {
      const e = index.entries[c.entryIndex];
      results.push({
        modelId: index.modelId,
        expressId: e.expressId,
        typeName: e.typeName,
        name: e.name,
        globalId: e.globalId,
        description: e.description,
        objectType: e.objectType,
        matchField: c.matchField,
        score: c.score,
      });
    }
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.modelId !== b.modelId) return a.modelId < b.modelId ? -1 : 1;
    return a.expressId - b.expressId;
  });

  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const key = `${r.modelId}:${r.expressId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

function scoreOneIndex(
  index: Tier1Index,
  rawQuery: string,
  needle: string,
  queryTokens: string[],
  looksLikeGuid: boolean,
): ScoredCandidate[] {
  const scored = new Map<number, ScoredCandidate>();

  const bump = (entryIndex: number, score: number, matchField: MatchField) => {
    const prev = scored.get(entryIndex);
    if (!prev || prev.score < score) {
      scored.set(entryIndex, { entryIndex, score, matchField });
    }
  };

  // GUID exact — O(1) and highest-ranked.
  if (looksLikeGuid) {
    const hit = index.globalIdMap.get(rawQuery);
    if (hit !== undefined) bump(hit, SCORE.GUID_EXACT, 'globalId');
  }

  // Candidate pool from the token index. For each query token:
  //   1. Exact token postings → TOKEN_MATCH per hit
  //   2. Prefix-matching tokens via sortedTokens range → TOKEN_MATCH
  // When the user typed a single token we still do a prefix expansion so
  // "wal" surfaces results with a "wall" token before they finish typing.
  const candidateSet = new Set<number>();
  const queryTokenHits = new Map<number, number>(); // entryIndex → count of query tokens matched

  for (const qt of queryTokens) {
    const matchedEntries = new Set<number>();
    const exact = index.tokenIndex.get(qt);
    if (exact) {
      for (let i = 0; i < exact.length; i++) matchedEntries.add(exact[i]);
    }
    // Prefix expansion for all query tokens (cheap when token count is small).
    const [plo, phi] = prefixRange(index.sortedTokens, qt);
    for (let ti = plo; ti < phi; ti++) {
      const tok = index.sortedTokens[ti];
      if (tok === qt) continue;
      const list = index.tokenIndex.get(tok);
      if (!list) continue;
      for (let i = 0; i < list.length; i++) matchedEntries.add(list[i]);
    }
    for (const entryIndex of matchedEntries) {
      candidateSet.add(entryIndex);
      queryTokenHits.set(entryIndex, (queryTokenHits.get(entryIndex) ?? 0) + 1);
    }
  }

  // Verify candidates against the full lowered strings first — this
  // resolves the matchField accurately (name / type / objectType /
  // description) when any substring-level match lands. If nothing
  // substring-level matches, the entry still qualifies via full token
  // coverage and falls back to a generic TOKEN_MATCH.
  for (const entryIndex of candidateSet) {
    const e = index.entries[entryIndex];
    const preSize = scored.size;
    scoreEntry(e, needle, entryIndex, bump);
    if (scored.size === preSize) {
      const hits = queryTokenHits.get(entryIndex) ?? 0;
      if (queryTokens.length > 0 && hits === queryTokens.length) {
        bump(entryIndex, SCORE.TOKEN_MATCH, 'name');
      }
    }
  }

  // Substring-fallback pass: for very short needles (<3 chars) OR needles
  // that contain punctuation the tokenizer would strip, the token index
  // has no coverage. Do a last-ditch linear sweep over the entries array.
  // This is still bounded by `entries.length` (populated rows only) not
  // the raw entity count, so it stays ~10× cheaper than Tier-0.
  if (candidateSet.size === 0 && (needle.length < 3 || /[\s\-_./:]/.test(needle))) {
    const entries = index.entries;
    for (let i = 0; i < entries.length; i++) {
      scoreEntry(entries[i], needle, i, bump);
    }
  }

  return Array.from(scored.values());
}

function scoreEntry(
  e: Tier1IndexEntry,
  needle: string,
  entryIndex: number,
  bump: (entryIndex: number, score: number, matchField: MatchField) => void,
): void {
  if (e.nameLower) {
    if (e.nameLower === needle) bump(entryIndex, SCORE.NAME_EXACT, 'name');
    else if (e.nameLower.startsWith(needle)) bump(entryIndex, SCORE.NAME_PREFIX, 'name');
    else if (e.nameLower.includes(needle)) bump(entryIndex, SCORE.NAME_SUBSTR, 'name');
  }
  if (e.typeNameLower === needle) bump(entryIndex, SCORE.TYPE_EXACT, 'type');
  else if (e.typeNameLower.startsWith(needle)) bump(entryIndex, SCORE.TYPE_PREFIX, 'type');
  if (e.objectTypeLower && e.objectTypeLower.includes(needle)) {
    bump(entryIndex, SCORE.OBJECTTYPE_SUBSTR, 'objectType');
  }
  if (e.descriptionLower && e.descriptionLower.includes(needle)) {
    bump(entryIndex, SCORE.DESCRIPTION_SUBSTR, 'description');
  }
}

/** Exposed for tests only. */
export const __internal = { tokenize, prefixRange };
