/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `useCompare` fingerprint-cache key (issue #1891, #4989): what makes a
 * previously-built `BuiltPair` still usable, so a scope / blacklist / matching
 * change can re-diff instantly instead of re-extracting. Split out of
 * `useCompare.ts` for the module-size house rule (AGENTS.md); re-exported
 * from there so its own consumers see no change.
 */

import { useViewerStore } from '@/store';
import type { EntityFingerprint } from '@ifc-lite/diff';
import type { CompareRef } from '@/lib/compare/buildFingerprints';

/** Read the live mesh-content version. A FUNCTION, not a captured number: the
 *  whole point is to observe the value moving across an extraction's awaits, so
 *  a caller that snapshots it once defeats the guard it feeds. */
export const readGeometryContentVersion = (): number =>
  useViewerStore.getState().geometryContentVersion;

type Side = EntityFingerprint<CompareRef>[];

export interface BuiltPair {
  baseModelId: string;
  headModelId: string;
  baseName: string;
  headName: string;
  base: Side;
  head: Side;
  /**
   * The authored key scheme (issue #4989) `base`/`head` were extracted
   * under — `undefined` for GlobalId. Captured once, with `baseId`/`headId`,
   * at the start of `runComparison`: unlike the diff options read inside
   * `publishCompareResult`, this drives EXTRACTION, so a mid-run change to it
   * cannot retroactively apply to fingerprints already being built. A later
   * change simply makes the cache stale (`isCurrentFor` below), and the next
   * `runComparison()` re-extracts under the new scheme.
   */
  keyProperty: string | undefined;
  /**
   * Authored values more than one entity carried, ACROSS BOTH `base` and
   * `head` (one shared `Map`, so a value duplicated on one side and unique
   * on the other still reports once). Populated by `resolveAuthoredKeys` via
   * `buildEntityFingerprints`; empty when `keyProperty` is `undefined` or no
   * value collided.
   */
  duplicateAuthoredKeys: Map<string, number[]>;
  /**
   * `geometryContentVersion` the fingerprints were extracted at (#1891).
   *
   * The A/B model ids are NOT enough to key this cache. Federation re-alignment
   * re-frames vertices and their world `geometryAabb`s IN PLACE, under the same
   * ids and the same `geometryResult` object, so fingerprints built before it
   * carry pre-alignment boxes while the meshes carry post-alignment ones — and
   * every move distance the engine derives from them is then measured between
   * two coordinate frames. That store counter is bumped by exactly one caller,
   * `realignFederation`, and only when something actually moved, so it is the
   * precise "mesh content was mutated under you" signal this cache was missing.
   */
  contentVersion: number;
}

/** Are these fingerprints the ones for this A/B pair, extracted from the mesh
 *  content the store holds NOW? (Ids compared field-wise rather than through a
 *  joined key string, so two ids can never alias.)
 *
 *  THE staleness predicate for the compare path — asked before a cached pair is
 *  reused, again after the extraction's awaits, and again before a cheap
 *  re-diff. One definition, so the three cannot drift apart. */
export function isCurrentFor(
  built: Pick<BuiltPair, 'baseModelId' | 'headModelId' | 'contentVersion' | 'keyProperty'>,
  baseModelId: string,
  headModelId: string,
  contentVersion: number,
  keyProperty: string | undefined,
): boolean {
  return built.baseModelId === baseModelId
    && built.headModelId === headModelId
    && built.contentVersion === contentVersion
    && built.keyProperty === keyProperty;
}
