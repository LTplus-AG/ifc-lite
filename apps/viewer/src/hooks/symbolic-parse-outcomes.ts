/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Viewer-private completion evidence (#6537). No source text or GPU fidelity
 * claim. Weak metadata cannot keep a result alive after its canonical LRU drops it. */
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { RoomSymbolicSource } from '@/lib/collab/room-symbolic-source';
import type { ElevationRebase, ParseResult } from '../lib/overlay-parse/symbolic-parse.js';
import type { FlatSymbolic } from '../lib/overlay-parse/symbolic-flat.js';
import type { OverlayRtcContext } from '../lib/overlay-parse/rtc-context.js';
import { hasSymbolicOwners } from './symbolic-parse-source-key.js';

export type ParseCompletion =
  | { readonly kind: 'success' }
  | { readonly kind: 'skip'; readonly reason: 'empty-source' | 'no-owner-types' }
  | { readonly kind: 'failure' }
  | { readonly kind: 'untracked' };
export interface SymbolicCounts {
  readonly lines: number;
  readonly texts: number;
  readonly fills: number;
}
type BucketCensus =
  | { readonly status: 'complete'; readonly buckets: number; readonly annotation: SymbolicCounts; readonly grid: SymbolicCounts }
  | { readonly status: 'refused'; readonly reason: 'bucket-budget' | 'unsafe-count' };
export type SymbolicParseOutcome =
  | { readonly phase: 'unobserved' | 'pending-frame' | 'inflight' | 'stale' | 'evicted' | 'untracked' }
  | { readonly phase: 'terminal'; readonly epoch: number; readonly completion: ParseCompletion; readonly census: BucketCensus };
type Terminal = Extract<SymbolicParseOutcome, { phase: 'terminal' }>;

const MAX_BUCKETS = 4096;
const FLAT_COMPLETIONS = new WeakMap<FlatSymbolic, ParseCompletion>();
const COMPLETIONS = new WeakMap<ParseResult, Terminal>();
// Deliberately never reset on cache clears/eviction: this is a live-session fence.
let completionEpoch = 0;
export function symbolicCompletionEpoch(): number { return completionEpoch; }
export function markFlatParse(flat: FlatSymbolic, completion: ParseCompletion): FlatSymbolic {
  FLAT_COMPLETIONS.set(flat, Object.freeze(completion));
  return flat;
}
export function flatParseCompletion(flat: FlatSymbolic): ParseCompletion {
  return FLAT_COMPLETIONS.get(flat) ?? { kind: 'untracked' };
}

function bucketCensus(result: ParseResult): BucketCensus {
  const buckets = result.byStorey.size + result.gridByStorey.size;
  if (buckets > MAX_BUCKETS) return { status: 'refused', reason: 'bucket-budget' };
  const count = (lines: number, texts: number, fills: number, groups: ParseResult['byStorey']): SymbolicCounts => {
    for (const group of groups.values()) {
      lines += group.lines.length;
      texts += group.texts.length;
      fills += group.fills.length;
    }
    return Object.freeze({ lines, texts, fills });
  };
  const annotation = count(result.loose.length, result.looseTexts.length, result.looseFills.length, result.byStorey);
  const grid = count(result.gridLoose.length, result.gridLooseTexts.length, result.gridLooseFills.length, result.gridByStorey);
  if (![...Object.values(annotation), ...Object.values(grid), buckets].every(Number.isSafeInteger)) {
    return { status: 'refused', reason: 'unsafe-count' };
  }
  return Object.freeze({ status: 'complete', buckets, annotation, grid });
}

/** Called once on the real completion (including catch/skip), before cache notification. */
export function completeSymbolicParse(result: ParseResult, completion: ParseCompletion): ParseResult {
  COMPLETIONS.set(result, Object.freeze({
    phase: 'terminal', epoch: ++completionEpoch,
    completion: Object.freeze(completion), census: Object.freeze(bucketCensus(result)),
  }));
  return result;
}

export interface SymbolicBindingContext {
  store: IfcDataStore;
  mutationView?: MutablePropertyView;
  mutationVersion: number;
  roomSource?: RoomSymbolicSource;
  rtc: OverlayRtcContext;
  elevationRebase: ElevationRebase;
}
interface Observation {
  key: string;
  source: number;
  roomSource: number;
  ownerStore: number;
  owners: boolean;
  elementToStorey: number;
  storeyElevations: number;
  mutationVersion: number;
  mutationView: number;
  rtcKey: string;
  primitive: number;
  storeyTable: number;
}
const OBSERVATIONS = new WeakMap<IfcDataStore, Observation>();
// A live store must not make its replaced source/maps/view/room survive solely
// through an observation. Tokens have weak object keys and scalar values.
const OBJECT_IDENTITIES = new WeakMap<object, number>();
let nextObjectIdentity = 1;
function producerIdentity(value: object | undefined): number {
  if (value === undefined) return 0;
  const existing = OBJECT_IDENTITIES.get(value);
  if (existing !== undefined) return existing;
  const identity = nextObjectIdentity++;
  OBJECT_IDENTITIES.set(value, identity);
  return identity;
}
function sameIdentity(identity: number, value: object | undefined): boolean {
  return value === undefined ? identity === 0 : OBJECT_IDENTITIES.get(value) === identity;
}

/** Capture the already-produced key and binding; never recompute a key on reads. */
export function observeSymbolicBinding(context: SymbolicBindingContext & { key: string }): void {
  const { store, roomSource, rtc, elevationRebase } = context;
  if (rtc.mode === 'pending') return;
  const source = roomSource?.source ?? store.source;
  const ownerStore = roomSource?.dataStore ?? store;
  // @raw-entity-enumeration-ok identity of the existing source hierarchy only; no membership query or enumeration, and mutation binding is tracked separately
  const elementToStorey = store.spatialHierarchy?.elementToStorey;
  OBSERVATIONS.set(store, {
    key: context.key, source: producerIdentity(source),
    roomSource: producerIdentity(roomSource), ownerStore: producerIdentity(ownerStore),
    owners: hasSymbolicOwners(ownerStore, source),
    elementToStorey: producerIdentity(elementToStorey),
    storeyElevations: producerIdentity(store.spatialHierarchy?.storeyElevations),
    mutationView: producerIdentity(context.mutationView), mutationVersion: context.mutationVersion,
    rtcKey: rtc.key, primitive: elevationRebase.primitive, storeyTable: elevationRebase.storeyTable,
  });
}

/** Cheap scalar/ref comparisons reuse the producer context. No hierarchy walk,
 * contentKey getter, source copy, ParseResult rebuild, parse, or cache refresh. */
export function readObservedSymbolicParse(
  context: SymbolicBindingContext,
  peek: (key: string) => { result?: ParseResult; inflight: boolean },
): SymbolicParseOutcome {
  if (context.rtc.mode === 'pending') return { phase: 'pending-frame' };
  const { store, roomSource, rtc, elevationRebase } = context;
  const observed = OBSERVATIONS.get(store);
  if (!observed) return { phase: 'unobserved' };
  const source = roomSource?.source ?? store.source;
  const ownerStore = roomSource?.dataStore ?? store;
  // @raw-entity-enumeration-ok passive reference comparison against the producer snapshot; live mutation bindings are checked below without enumerating source membership
  const elementToStorey = store.spatialHierarchy?.elementToStorey;
  if (!sameIdentity(observed.source, source) || !sameIdentity(observed.roomSource, roomSource)
    || !sameIdentity(observed.ownerStore, ownerStore)
    || observed.owners !== hasSymbolicOwners(ownerStore, source)
    || !sameIdentity(observed.elementToStorey, elementToStorey)
    || !sameIdentity(observed.storeyElevations, store.spatialHierarchy?.storeyElevations)
    || !sameIdentity(observed.mutationView, context.mutationView) || observed.mutationVersion !== context.mutationVersion
    || observed.rtcKey !== rtc.key
    || !Object.is(observed.primitive, elevationRebase.primitive)
    || !Object.is(observed.storeyTable, elevationRebase.storeyTable)) return { phase: 'stale' };
  const current = peek(observed.key);
  // During notification the result is cached but finally has not cleared in-flight yet.
  if (current.inflight) return { phase: 'inflight' };
  if (!current.result) return { phase: 'evicted' };
  return COMPLETIONS.get(current.result) ?? { phase: 'untracked' };
}
