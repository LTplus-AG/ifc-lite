/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


import type { IfcDataStore } from '@ifc-lite/parser';
import type { ElevationRebase } from '../lib/overlay-parse/symbolic-parse.js';
import type { OverlayRtcContext } from '../lib/overlay-parse/rtc-context.js';
import type { SpatialBucketSnapshot } from './symbolic-parse-cache-keys.js';
import { roomSymbolicSource } from '@/lib/collab/room-symbolic-source';
import { hasEntityType } from './has-entity-type.js';
import { OVERLAY_OWNER_TYPE_NAMES } from '../lib/overlay-parse/overlay-channels.js';

/** Stable cache key for one parsed source.
 *
 * Was a sampled hash (head/middle/tail, 96 bytes) chosen to avoid walking the
 * whole file. `IfcSourceBytes.contentKey` is a full-content hash computed once
 * and cached on the source, so this is now both cheaper per call and stronger:
 * the sampled form could alias two files sharing a size and those windows,
 * which showed up as a federated model's annotations silently not rendering
 * because the parse effect skipped it as already cached (#2183).
 */
export function sourceKey(
  store: IfcDataStore,
  rebase: ElevationRebase,
  rtc: Exclude<OverlayRtcContext, { mode: 'pending' }>,
  spatial: SpatialBucketSnapshot,
): string | null {
  const roomSource = roomSymbolicSource(store);
  const contentKey = (roomSource?.source ?? store.source).contentKey ?? null;
  if (!contentKey) return null;
  const ownerSource = roomSource?.source ?? store.source;
  const ownerStore = roomSource?.dataStore ?? store;
  const hasOwners = hasSymbolicOwners(ownerStore, ownerSource);
  // The flat worker output depends on source bytes, but ParseResult also
  // contains buckets assembled from this store's current spatial lookups.
  // Identical IFC bytes can be paired with different live hierarchies (for
  // example after a server refresh), so those lookup values must participate
  // in the result key as well.
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
  return `${contentKey}|${rtc.key}|${rebase.primitive}|${rebase.storeyTable}|${spatial.key}|owners:${hasOwners}`;
}


/** Same constant-time owner prefilter used by the worker and canonical key. */
export function hasSymbolicOwners(store: IfcDataStore, source = store.source): boolean {
  return source.byteLength > 0 ? hasEntityType(store, ...OVERLAY_OWNER_TYPE_NAMES) : true;
}
