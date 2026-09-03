/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The module-global cache behind the symbolic-annotation hooks: how a parse is
 * keyed, how it is run, and how consumers learn a result landed.
 *
 * Split out of `useSymbolicAnnotations.ts`, which had grown past the ~400-line
 * production-module budget. Nothing here is React-aware; the hook file keeps
 * the rendering and the store wiring.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { hasEntityType } from './has-entity-type.js';
import {
  buildParseResult,
  createEmptyParseResult,
  debugEnabled,
  type ElevationRebase,
  type ParseResult,
} from '../lib/overlay-parse/symbolic-parse.js';
import { getWholeSourceForWorker, parseSymbolicFlat } from '../lib/overlay-parse/index.js';
import { OVERLAY_OWNER_TYPE_NAMES } from '../lib/overlay-parse/overlay-channels.js';
import { totalYupOffset } from '../lib/geo/ifc-origin.js';

/**
 * Stable cache key for one parsed source.
 *
 * Was a sampled hash (head/middle/tail, 96 bytes) chosen to avoid walking the
 * whole file. `IfcSourceBytes.contentKey` is a full-content hash computed once
 * and cached on the source, so this is now both cheaper per call and stronger:
 * the sampled form could alias two files sharing a size and those windows,
 * which showed up as a federated model's annotations silently not rendering
 * because the parse effect skipped it as already cached (#2183).
 */
function sourceKey(store: IfcDataStore, rebase: ElevationRebase): string | null {
  const contentKey = store.source.contentKey ?? null;
  if (!contentKey) return null;
  // The cached `ParseResult` has the elevation rebase baked into it, and that
  // rebase is NOT a function of the source bytes: it carries `originShift`,
  // which federation and re-alignment set per model. Two models loaded from
  // identical bytes at different placements share a `contentKey` and need
  // different results, so the frame belongs in the key.
  //
  // The frame is a PARAMETER rather than read here, but that alone guarantees
  // nothing: what keeps a key honest is `ensureParseFor` reading the frame ONCE
  // and handing the same value to both the key and the parse. Read it twice
  // around the await and you file a result under a key describing a frame it
  // was not rebased for — see `useSymbolicAnnotations.frameRace.test.ts`.
  return `${contentKey}|${rebase.primitive}|${rebase.storeyTable}`;
}

/**
 * Parse one store's symbolic annotations.
 *
 * The WASM walk runs in the overlay worker (`lib/overlay-parse`); this
 * wrapper supplies the entity-index pre-filter, which needs
 * `store.entityIndex`, and reassembles the flat primitive stream into buckets
 * with the storey lookups, which never leave the main thread.
 */
async function parseAnnotations(
  store: IfcDataStore,
  elevationRebase: ElevationRebase,
): Promise<ParseResult> {
  const source = store.source;
  // Skip the full-source WASM scan only when the model has none of the classes
  // `overlay-channels.ts` lists — this parse path ALSO feeds the grid buckets
  // (gridByStorey / gridLoose*), so gating on the annotation channel's classes
  // alone would drop grid-only models. Reading the table rather than naming the
  // classes here is what stops a third owner class being added to the overlay
  // and silently leaving this short-circuit behind.
  // The scan copies the entire IFC source into the WASM heap on the main thread,
  // so skipping it when there is nothing to find still matters.
  //
  if (source && source.byteLength > 0 && !hasEntityType(store, ...OVERLAY_OWNER_TYPE_NAMES)) {
    if (debugEnabled()) console.log(`[annotations] skip: no ${OVERLAY_OWNER_TYPE_NAMES.join('/')} entities`);
    return createEmptyParseResult();
  }
  if (!source || source.byteLength === 0) {
    if (debugEnabled()) console.log('[annotations] skip: missing/empty source');
    return createEmptyParseResult();
  }

  // The WASM walk runs in the overlay worker and is terminated afterwards;
  // running it here grew a main-thread WASM heap that never shrinks, worth
  // ~471 MB on a 342 MB model (#2183). Only the flat primitive stream crosses
  // back — bucketing stays here, so the storey lookups never leave the main
  // thread and `ensureBucket` keeps its exact semantics.
  // `getWholeSourceForWorker` is the single seam for handing a model's bytes
  // to a worker — see `lib/overlay-parse/source-handoff.ts`.
  const flat = await parseSymbolicFlat(getWholeSourceForWorker(store), debugEnabled());
  return buildParseResult(flat, {
    elementToStorey: store.spatialHierarchy?.elementToStorey,
    storeyElevations: store.spatialHierarchy?.storeyElevations,
    elevationRebase,
  });
}

/**
 * The render-frame elevation offsets for the model that owns `store`.
 *
 * `totalYupOffset(info).y` is `originShift.y + rtc.z` — the whole distance
 * between an IFC elevation and the renderer's Y (`lib/geo/ifc-origin.ts`).
 * The wasm extractor has already removed the `rtc.z` half from
 * `primitive.worldY` (`rust/processing/src/symbolic/rebase.rs`), so only the
 * remainder applies there, while a raw storey-table elevation needs all of
 * it. Derived from ONE offset read so the two cannot drift apart.
 *
 * Read once per parse and baked into the cached `ParseResult`. Unlike the RTC
 * subtraction the wasm walk bakes into the same primitives, this is NOT a
 * function of the source bytes — RTC is derived from the model's own
 * coordinates, while `totalYupOffset` also carries `originShift`, which
 * federation and re-alignment set per model. That is why `sourceKey` mixes
 * these two values into the parse-cache key rather than keying on
 * `contentKey` alone.
 */
function elevationRebaseFor(store: IfcDataStore): ElevationRebase {
  const state = useViewerStore.getState();
  let info = state.geometryResult?.coordinateInfo ?? null;
  for (const [, model] of state.models) {
    if (model.ifcDataStore === store && model.geometryResult?.coordinateInfo) {
      info = model.geometryResult.coordinateInfo;
      break;
    }
  }
  const total = totalYupOffset(info ?? undefined).y;
  const rtcZ = info?.wasmRtcOffset?.z ?? 0;
  return { primitive: total - rtcZ, storeyTable: total };
}

// ─── Shared parse cache ─────────────────────────────────────────────────────
// Parsing the whole file's symbolic representations is not cheap (full WASM
// walk over every product's representations). Cache results module-globally
// so the line / text / fill hooks share one parse per model source instead
// of triggering it once per hook.
const PARSE_CACHE = new Map<string, ParseResult>();
const PARSE_INFLIGHT = new Map<string, Promise<void>>();

/** Subscribers that want to re-render when a new parse result lands. */
type CacheListener = () => void;
const CACHE_LISTENERS = new Set<CacheListener>();
function notifyCacheChange(): void {
  for (const fn of CACHE_LISTENERS) fn();
}

/**
 * Exported for unit testing (retry-storm regression, see
 * `useSymbolicAnnotations.retryStorm.test.ts`). Returns the in-flight
 * promises so a test can await completion without polling module state.
 */
export function ensureParseFor(stores: IfcDataStore[]): Promise<void>[] {
  const started: Promise<void>[] = [];
  for (const store of stores) {
    // One read, used for both the key and the parse: see `sourceKey`.
    const elevationRebase = elevationRebaseFor(store);
    const key = sourceKey(store, elevationRebase);
    if (!key) continue;
    if (PARSE_CACHE.has(key)) continue;
    const existing = PARSE_INFLIGHT.get(key);
    if (existing) {
      started.push(existing);
      continue;
    }

    const promise = (async () => {
      try {
        const result = await parseAnnotations(store, elevationRebase);
        PARSE_CACHE.set(key, result);
        notifyCacheChange();
      } catch (error) {
        // Cache empty on failure so we don't retry a doomed parse every tick
        // (matches useAlignmentLines3D — a model whose annotation section is
        // malformed would otherwise re-run the full-source WASM walk on
        // every `stores` dependency change).
        // eslint-disable-next-line no-console
        console.warn('[useSymbolicAnnotations] parse failed:', error);
        PARSE_CACHE.set(key, createEmptyParseResult());
        notifyCacheChange();
      } finally {
        PARSE_INFLIGHT.delete(key);
      }
    })();
    PARSE_INFLIGHT.set(key, promise);
    started.push(promise);
  }
  return started;
}

/** @internal test-only reset of the module-level parse cache. */
export function __resetSymbolicAnnotationsCacheForTests(): void {
  PARSE_CACHE.clear();
  PARSE_INFLIGHT.clear();
}

/**
 * @internal test-only view of the parse-cache key for a store. The key mixes
 * the elevation rebase into `contentKey`, so a test must not spell it out as a
 * literal — that would pass for the wrong reason the moment the key changes.
 */
export function __symbolicAnnotationsSourceKeyForTests(
  store: IfcDataStore | null | undefined,
  rebase?: ElevationRebase,
): string | null {
  if (!store) return null;
  return sourceKey(store, rebase ?? elevationRebaseFor(store));
}

/** @internal test-only peek at how many entries are cached for a source key. */
export function __symbolicAnnotationsCacheHasForTests(key: string): boolean {
  return PARSE_CACHE.has(key);
}

/**
 * The parsed result for one store, or undefined when the store has no usable
 * source key or its parse has not landed yet.
 *
 * Takes the store rather than the key so the cache key stays private: it is
 * not a stable identity a caller could hold onto, since `elevationRebaseFor`
 * mixes in a frame that federation and re-alignment change under it.
 */
export function getParseFor(store: IfcDataStore | null | undefined): ParseResult | undefined {
  const key = store ? sourceKey(store, elevationRebaseFor(store)) : null;
  return key === null ? undefined : PARSE_CACHE.get(key);
}

/**
 * Subscribe to parse-cache completions. Returns the unsubscribe function, so
 * a caller cannot leak a listener by forgetting which set to delete from.
 */
export function subscribeToParseCache(listener: () => void): () => void {
  CACHE_LISTENERS.add(listener);
  return () => {
    CACHE_LISTENERS.delete(listener);
  };
}
