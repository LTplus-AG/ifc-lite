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

import type { IfcDataStore, IfcSourceBytes } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import {
  buildParseResult,
  createEmptyParseResult,
  debugEnabled,
  type ElevationRebase,
  type ParseResult,
} from '../lib/overlay-parse/symbolic-parse.js';
import { getWholeSourceForWorker, parseSymbolicFlatWithOutcome } from '../lib/overlay-parse/index.js';
import { createEmptyFlatSymbolic, type FlatSymbolic } from '../lib/overlay-parse/symbolic-flat.js';
import { OVERLAY_OWNER_TYPE_NAMES } from '../lib/overlay-parse/overlay-channels.js';
import {
  placeRoomSymbolic,
  roomSymbolicSource,
  type RoomSymbolicSource,
} from '@/lib/collab/room-symbolic-source';
import { overlayRtcContextFor, type OverlayRtcContext } from '../lib/overlay-parse/rtc-context.js';
import type { RtcFrame } from '@ifc-lite/geometry';
import { resetSpatialBucketSnapshotsForTests, sourceFlatKey, spatialBucketSnapshotFor, type SpatialBucketSnapshot } from './symbolic-parse-cache-keys.js';
import { PARSE_CACHE, PARSE_INFLIGHT, cacheParseResult, cacheRoomParseResult } from './symbolic-parse-result-cache.js';
import { clearSourceFlatCache, getSourceFlat } from './symbolic-source-flat-cache.js';
import { elevationRebaseFor } from './symbolic-parse-cache-frame.js';
import { sourceKey, hasSymbolicOwners } from './symbolic-parse-source-key.js';
import { completeSymbolicParse, flatParseCompletion, markFlatParse, observeSymbolicBinding, readObservedSymbolicParse, symbolicCompletionEpoch } from './symbolic-parse-outcomes.js';
import { installSymbolicParseOutcomeReader } from '../store/symbolic-parse-observer.js';

export interface SymbolicParseStoreBinding {
  store: IfcDataStore;
  mutationView?: MutablePropertyView;
}

function bindingOf(value: IfcDataStore | SymbolicParseStoreBinding): SymbolicParseStoreBinding {
  return 'store' in value ? value : { store: value };
}

async function parseFlatAnnotations(
  store: IfcDataStore,
  source: IfcSourceBytes,
  frame?: RtcFrame,
): Promise<FlatSymbolic> {
  if (source.byteLength > 0 && !hasSymbolicOwners(store, source)) {
    if (debugEnabled()) console.log(`[annotations] skip: no ${OVERLAY_OWNER_TYPE_NAMES.join('/')} entities`);
    return markFlatParse(createEmptyFlatSymbolic(), { kind: 'skip', reason: 'no-owner-types' });
  }
  if (source.byteLength === 0) {
    if (debugEnabled()) console.log('[annotations] skip: missing/empty source');
    return markFlatParse(createEmptyFlatSymbolic(), { kind: 'skip', reason: 'empty-source' });
  }
  const parsed = await parseSymbolicFlatWithOutcome(getWholeSourceForWorker({ source }), debugEnabled(), 'overlay', frame);
  return markFlatParse(parsed.flat, { kind: parsed.kind });
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
  frame: RtcFrame | undefined,
  sourceFlat: FlatSymbolic | undefined,
  spatial: SpatialBucketSnapshot,
): Promise<ParseResult> {
  const roomSource = roomSymbolicSource(store);
  const source = roomSource?.source ?? store.source;
  // Skip the full-source WASM scan only when the model has none of the classes
  // `overlay-channels.ts` lists — this parse path ALSO feeds the grid buckets
  // (gridByStorey / gridLoose*), so gating on the annotation channel's classes
  // alone would drop grid-only models. Reading the table rather than naming the
  // classes here is what stops a third owner class being added to the overlay
  // and silently leaving this short-circuit behind.
  // The scan copies the entire IFC source into the WASM heap on the main thread,
  // so skipping it when there is nothing to find still matters.
  //
  if (!source || source.byteLength === 0) {
    if (debugEnabled()) console.log('[annotations] skip: missing/empty source');
    return completeSymbolicParse(createEmptyParseResult(), { kind: 'skip', reason: 'empty-source' });
  }

  // The WASM walk runs in the overlay worker and is terminated afterwards;
  // running it here grew a main-thread WASM heap that never shrinks, worth
  // ~471 MB on a 342 MB model (#2183). Only the flat primitive stream crosses
  // back — bucketing stays here, so the storey lookups never leave the main
  // thread and `ensureBucket` keeps its exact semantics.
  // `getWholeSourceForWorker` is the single seam for handing a model's bytes
  // to a worker — see `lib/overlay-parse/source-handoff.ts`.
  let flat = sourceFlat ?? await parseFlatAnnotations(store, source, frame);
  const completion = flatParseCompletion(flat);
  if (roomSource) flat = placeRoomSymbolic(flat, roomSource);
  return completeSymbolicParse(buildParseResult(flat, {
    elementToStorey: spatial.elementToStorey,
    storeyElevations: spatial.storeyElevations,
    elevationRebase,
    isOwnerDeleted: spatial.deletedOwners ? (id) => spatial.deletedOwners!.has(id) : undefined,
  }), completion);
}

// The worker output is a function of source bytes and its producer RTC frame.
// Keep it separate from ParseResult, whose storey buckets are assembled from
// the current store's live spatial hierarchy.
function sourceFlatFor(
  store: IfcDataStore,
  rtc: Exclude<OverlayRtcContext, { mode: 'pending' }>,
): Promise<FlatSymbolic> {
  // Do not cache a negative type-index prefilter: the same source can be
  // paired with a refreshed index that now contains the overlay owner class.
  if (store.source.byteLength > 0 && !hasSymbolicOwners(store)) {
    return Promise.resolve(markFlatParse(createEmptyFlatSymbolic(), { kind: 'skip', reason: 'no-owner-types' }));
  }
  const key = sourceFlatKey(store, rtc);
  if (!key) return parseFlatAnnotations(store, store.source, rtc.frame);
  return getSourceFlat(key, () => parseFlatAnnotations(store, store.source, rtc.frame));
}

// ─── Shared parse cache ─────────────────────────────────────────────────────
// Parsing the whole file's symbolic representations is not cheap (full WASM
// walk over every product's representations). Cache results module-globally
// so the line / text / fill hooks share one parse per model source instead
// of triggering it once per hook.
// Portable STEP bytes are stable across CRDT reconstructions. Cache their
// source-space worker output once, then remap owners for each current binding.
// Binding-specific results live under weak keys, so repeated edits do not grow
// the module cache after their reconstructed stores become unreachable.
let ROOM_FLAT_CACHE = new WeakMap<IfcDataStore, FlatSymbolic>();
let ROOM_FLAT_INFLIGHT = new WeakMap<IfcDataStore, Promise<FlatSymbolic>>();
let ROOM_PARSE_CACHE = new WeakMap<RoomSymbolicSource, Map<string, ParseResult>>();
let ROOM_PARSE_INFLIGHT = new WeakMap<RoomSymbolicSource, Map<string, Promise<void>>>();

function roomFlat(roomSource: RoomSymbolicSource): Promise<FlatSymbolic> {
  const key = roomSource.dataStore;
  const cached = ROOM_FLAT_CACHE.get(key);
  if (cached) return Promise.resolve(cached);
  const existing = ROOM_FLAT_INFLIGHT.get(key);
  if (existing) return existing;
  // Portable room STEP bytes are a different source from the reconstructed
  // model and carry no producer-frame provenance of their own.
  const promise = parseFlatAnnotations(roomSource.dataStore, roomSource.source)
    .then((flat) => {
      ROOM_FLAT_CACHE.set(key, flat);
      return flat;
    })
    .finally(() => ROOM_FLAT_INFLIGHT.delete(key));
  ROOM_FLAT_INFLIGHT.set(key, promise);
  return promise;
}

function ensureRoomParse(
  store: IfcDataStore,
  roomSource: RoomSymbolicSource,
  key: string,
  elevationRebase: ElevationRebase,
  spatial: SpatialBucketSnapshot,
): Promise<void> | null {
  const cached = ROOM_PARSE_CACHE.get(roomSource);
  if (cached?.has(key)) return null;
  const inflight = ROOM_PARSE_INFLIGHT.get(roomSource);
  const existing = inflight?.get(key);
  if (existing) return existing;

  const promise = (async () => {
    let result: ParseResult;
    try {
      result = await parseAnnotations(store, elevationRebase, undefined, await roomFlat(roomSource), spatial);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[useSymbolicAnnotations] room parse failed:', error);
      result = completeSymbolicParse(createEmptyParseResult(), { kind: 'failure' });
    }
    let entries = ROOM_PARSE_CACHE.get(roomSource);
    if (!entries) {
      entries = new Map();
      ROOM_PARSE_CACHE.set(roomSource, entries);
    }
    cacheRoomParseResult(entries, key, result);
    notifyCacheChange();
  })().finally(() => ROOM_PARSE_INFLIGHT.get(roomSource)?.delete(key));

  let entries = inflight;
  if (!entries) {
    entries = new Map();
    ROOM_PARSE_INFLIGHT.set(roomSource, entries);
  }
  entries.set(key, promise);
  return promise;
}

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
export function ensureParseFor(stores: Array<IfcDataStore | SymbolicParseStoreBinding>): Promise<void>[] {
  const started: Promise<void>[] = [];
  const mutationVersion = useViewerStore.getState().mutationVersion ?? 0;
  for (const value of stores) {
    const { store, mutationView } = bindingOf(value);
    // One read, used for both the key and the parse: see `sourceKey`.
    const elevationRebase = elevationRebaseFor(store);
    const roomSource = roomSymbolicSource(store);
    const rtc = roomSource
      ? { mode: 'standalone' as const, key: 'standalone' as const, frame: undefined }
      : overlayRtcContextFor(store);
    if (rtc.mode === 'pending') continue;
    const spatial = spatialBucketSnapshotFor(store, mutationVersion, mutationView);
    const key = sourceKey(store, elevationRebase, rtc, spatial);
    if (!key) continue;
    observeSymbolicBinding({ store, mutationView, mutationVersion, roomSource, rtc, elevationRebase, key });
    if (roomSource) {
      const promise = ensureRoomParse(store, roomSource, key, elevationRebase, spatial);
      if (promise) started.push(promise);
      continue;
    }
    if (PARSE_CACHE.has(key)) continue;
    const existing = PARSE_INFLIGHT.get(key);
    if (existing) {
      started.push(existing);
      continue;
    }

    const promise = (async () => {
      try {
        const result = await parseAnnotations(store, elevationRebase, rtc.frame, await sourceFlatFor(store, rtc), spatial);
        cacheParseResult(key, result);
        notifyCacheChange();
      } catch (error) {
        // Cache empty on failure so we don't retry a doomed parse every tick
        // (matches useAlignmentLines3D — a model whose annotation section is
        // malformed would otherwise re-run the full-source WASM walk on
        // every `stores` dependency change).
        // eslint-disable-next-line no-console
        console.warn('[useSymbolicAnnotations] parse failed:', error);
        cacheParseResult(key, completeSymbolicParse(createEmptyParseResult(), { kind: 'failure' }));
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
  resetSpatialBucketSnapshotsForTests();
  clearSourceFlatCache();
  ROOM_FLAT_CACHE = new WeakMap();
  ROOM_FLAT_INFLIGHT = new WeakMap();
  ROOM_PARSE_CACHE = new WeakMap();
  ROOM_PARSE_INFLIGHT = new WeakMap();
}

/** @internal test-only probe for one weakly retained portable STEP parse. */
export function __symbolicAnnotationsRoomFlatCacheHasForTests(store: IfcDataStore): boolean {
  return ROOM_FLAT_CACHE.has(store);
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
  const rtc = roomSymbolicSource(store)
    ? { mode: 'standalone' as const, key: 'standalone' as const, frame: undefined }
    : overlayRtcContextFor(store);
  if (rtc.mode === 'pending') return null;
  const mutationVersion = useViewerStore.getState().mutationVersion ?? 0;
  return sourceKey(store, rebase ?? elevationRebaseFor(store), rtc, spatialBucketSnapshotFor(store, mutationVersion));
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
export function getParseFor(value: IfcDataStore | SymbolicParseStoreBinding | null | undefined): ParseResult | undefined {
  if (!value) return undefined;
  const { store, mutationView } = bindingOf(value);
  const rtc = roomSymbolicSource(store)
    ? { mode: 'standalone' as const, key: 'standalone' as const, frame: undefined }
    : overlayRtcContextFor(store);
  if (rtc.mode === 'pending') return undefined;
  const mutationVersion = useViewerStore.getState().mutationVersion ?? 0;
  const spatial = spatialBucketSnapshotFor(store, mutationVersion, mutationView);
  const key = sourceKey(store, elevationRebaseFor(store), rtc, spatial);
  if (key === null) return undefined;
  const roomSource = roomSymbolicSource(store);
  return roomSource ? ROOM_PARSE_CACHE.get(roomSource)?.get(key) : PARSE_CACHE.get(key);
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

// Passive viewer-private observer: no ensureParseFor, content hashing, or spatial walk.
installSymbolicParseOutcomeReader({
  epoch: symbolicCompletionEpoch,
  read: (store, mutationView, mutationVersion) => {
    const roomSource = roomSymbolicSource(store);
    const rtc = roomSource
      ? { mode: 'standalone' as const, key: 'standalone' as const, frame: undefined }
      : overlayRtcContextFor(store);
    return readObservedSymbolicParse(
      { store, mutationView, mutationVersion, roomSource, rtc, elevationRebase: elevationRebaseFor(store) },
      (key) => ({
        result: roomSource ? ROOM_PARSE_CACHE.get(roomSource)?.get(key) : PARSE_CACHE.get(key),
        inflight: roomSource ? (ROOM_PARSE_INFLIGHT.get(roomSource)?.has(key) ?? false) : PARSE_INFLIGHT.has(key),
      }),
    );
  },
});
