/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model-comparison orchestration hook (issue #924).
 *
 * Owns the "run a comparison" action for the Compare panel: it reads the two
 * chosen federated models from the store, builds per-entity fingerprints via
 * the viewer adapter, and runs the `@ifc-lite/diff` engine. Building
 * fingerprints (on-demand property extraction per entity) is the expensive
 * part, so the built sides are cached per A/B pair - toggling the
 * data/geometry scope OR the ignored-classes blacklist re-runs only the cheap
 * `diffModels` pass.
 *
 * Mirrors `useClash`: the slice holds dumb state, the hook does the work.
 */

import { useCallback, useEffect, useRef } from 'react';
import { diffModels, type EntityFingerprint } from '@ifc-lite/diff';
import { useViewerStore } from '@/store';
import { posthog } from '@/lib/analytics';
import type { CompareResult } from '@/store/slices/compareSlice';
import {
  buildEntityFingerprints,
  hasGeometryHashes,
  type CompareRef,
} from '@/lib/compare/buildFingerprints';
import { contentMatchCounts, contentMatchingRan } from '@/lib/compare/contentMatches';
import { buildAtCurrentVersion } from '@/lib/compare/versionedBuild';

/** Read the live mesh-content version. A FUNCTION, not a captured number: the
 *  whole point is to observe the value moving across an extraction's awaits, so
 *  a caller that snapshots it once defeats the guard it feeds. */
export const readGeometryContentVersion = (): number =>
  useViewerStore.getState().geometryContentVersion;

type Side = EntityFingerprint<CompareRef>[];
interface BuiltPair {
  baseModelId: string;
  headModelId: string;
  baseName: string;
  headName: string;
  base: Side;
  head: Side;
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
  built: Pick<BuiltPair, 'baseModelId' | 'headModelId' | 'contentVersion'>,
  baseModelId: string,
  headModelId: string,
  contentVersion: number,
): boolean {
  return built.baseModelId === baseModelId
    && built.headModelId === headModelId
    && built.contentVersion === contentVersion;
}

/** Canonical, order-independent signature of a blacklist so a re-render with a
 *  fresh-but-equivalent array reference doesn't trigger a re-diff. Compared
 *  against the engine's already-normalized `diff.excludedTypes`. */
function excludedSignature(types: Iterable<string>): string {
  const set = new Set<string>();
  for (const t of types) {
    const n = typeof t === 'string' ? t.trim().toUpperCase() : '';
    if (n) set.add(n);
  }
  return [...set].sort().join(' ');
}

/** Federation global ids to hide for the blacklist (#1470): every meshed copy
 *  (A and B) of any entity whose class is excluded in EITHER revision, mirroring
 *  the engine's union exclusion so a cross-version re-class doesn't leave one
 *  copy stranded on screen. Empty set when nothing is excluded. */
function collectExcludedHiddenIds(built: BuiltPair, excludedTypes: string[]): Set<number> {
  const ids = new Set<number>();
  const excluded = new Set(excludedTypes.map((t) => t.trim().toUpperCase()).filter(Boolean));
  if (excluded.size === 0) return ids;
  const isExcluded = (fp: EntityFingerprint<CompareRef>): boolean =>
    excluded.has(fp.ifcType.trim().toUpperCase());
  // Keys excluded on either side (a re-class can be excluded via A's or B's type).
  const excludedKeys = new Set<string>();
  for (const side of [built.base, built.head]) {
    for (const fp of side) if (isExcluded(fp)) excludedKeys.add(fp.key);
  }
  // Hide every copy of an excluded key.
  for (const side of [built.base, built.head]) {
    for (const fp of side) if (excludedKeys.has(fp.key)) ids.add(fp.ref.globalId);
  }
  return ids;
}

/**
 * Run the (cheap) diff pass for the cached fingerprints, derive the overlay's
 * hidden set, and publish the whole comparison to the store. The single place a
 * `CompareResult` is ever produced - both the Run button and the reconciliation
 * effect below go through here.
 *
 * INVARIANT this function exists to protect (the #1891 P1 fix). The diff options
 * are read HERE, and nothing may `await` between that read and
 * `setCompareResult`:
 *
 * - **Read here, never in a caller.** The scope / blacklist / matching controls
 *   stay live while a comparison is in flight, so a value captured before
 *   `runComparison`'s awaits (the frame yield plus fingerprint extraction) can be
 *   stale by the time the fingerprints land. Publishing such a value made the
 *   panel disagree with its own controls - counts, rows, overlay and exported CSV
 *   all - until the user moved some other option or re-ran. Latent since #924 for
 *   scope + blacklist; the content-matching checkbox is merely the first of the
 *   three a user reaches for mid-run.
 * - **Stay synchronous.** With no `await` between the read and the publish, no
 *   event handler can interleave, so the published result cannot be stale by even
 *   one option change. Adding an `await` in here reintroduces the P1.
 *
 * Together those are what let the reconciliation effect below omit `result` from
 * its deps: a published result always agrees with the store, so there is nothing
 * for a `result`-triggered re-run to catch, and no `setCompareResult` ->
 * re-render -> re-diff cycle.
 *
 * Fingerprint extraction (the expensive part) already happened, so this is cheap
 * enough to re-run on every scope / blacklist / matching change.
 *
 * @returns the published result, plus the matching flag it ran with - telemetry
 *   reports the OPTION, of which `diff.contentMatches` is only a derivation.
 */
function publishCompareResult(built: BuiltPair): {
  result: CompareResult;
  matchByContent: boolean;
} {
  const store = useViewerStore.getState();
  const scope: CompareResult['scope'] = store.compareScope;
  const excludedTypes = store.compareExcludedTypes;
  const matchByContent = store.compareMatchByContent;

  const diff = diffModels(built.base, built.head, {
    scope,
    excludeTypes: excludedTypes,
    // #1891. On by default: a from-scratch re-export re-GUIDs every element,
    // and a pure key diff then reports the entire model as deleted-and-added.
    // No `aabb` is supplied yet (that needs the mesh-bounds plumbing), so a 1:1
    // geometry mismatch degrades to a bare `moved` with no distance — the
    // engine's documented fallback, not a silent wrong answer.
    matchUnpairedByContent: matchByContent,
  });
  // Geometry hashes are produced only on the WASM mesh path; if either side was
  // loaded without them (e.g. a huge native desktop load), geometry/both scopes
  // can't see shape changes - flag it so the panel can warn.
  const geometryUnavailable = !hasGeometryHashes(built.base) || !hasGeometryHashes(built.head);
  const result: CompareResult = {
    baseModelId: built.baseModelId,
    headModelId: built.headModelId,
    baseName: built.baseName,
    headName: built.headName,
    scope,
    geometryUnavailable,
    excludedHiddenIds: collectExcludedHiddenIds(built, excludedTypes),
    diff,
  };
  store.setCompareResult(result);
  // Completed-comparison signal for baseline consumers (compare tour). An
  // option change re-diffing the cached fingerprints is a completed comparison
  // too, so it bumps the same counter.
  store.bumpCompareRunSeq();
  // A retired pair's entries are gone, so a selection made under one setting can
  // dangle under the other - drop it rather than leave a detail panel pointing
  // at nothing.
  store.setCompareSelectedKey(null);
  return { result, matchByContent };
}

export function useCompare() {
  const baseModelId = useViewerStore((s) => s.compareBaseModelId);
  const headModelId = useViewerStore((s) => s.compareHeadModelId);
  const scope = useViewerStore((s) => s.compareScope);
  const excludedTypes = useViewerStore((s) => s.compareExcludedTypes);
  const matchByContent = useViewerStore((s) => s.compareMatchByContent);
  const running = useViewerStore((s) => s.compareRunning);
  const result = useViewerStore((s) => s.compareResult);
  const error = useViewerStore((s) => s.compareError);
  const geometryContentVersion = useViewerStore((s) => s.geometryContentVersion);

  // Cache the built fingerprints for the current pair so a scope / blacklist
  // change is a cheap re-diff rather than a full re-extraction.
  const builtRef = useRef<BuiltPair | null>(null);

  const runComparison = useCallback(async () => {
    const store = useViewerStore.getState();
    const baseId = store.compareBaseModelId;
    const headId = store.compareHeadModelId;

    if (!baseId || !headId) {
      store.setCompareError('Select a model for both A and B.');
      return;
    }
    if (baseId === headId) {
      store.setCompareError('Pick two different models to compare.');
      return;
    }

    const baseModel = store.models.get(baseId);
    const headModel = store.models.get(headId);
    if (!baseModel?.ifcDataStore || !baseModel.geometryResult) {
      store.setCompareError('Version A is not fully loaded yet.');
      return;
    }
    if (!headModel?.ifcDataStore || !headModel.geometryResult) {
      store.setCompareError('Version B is not fully loaded yet.');
      return;
    }
    // Pin the validated handles for the extraction closure below. `geometryResult`
    // survives a re-align by IDENTITY - it is mutated in place, not replaced - so
    // a retry re-reads the re-framed meshes through these same references.
    const baseStore = baseModel.ifcDataStore;
    const baseGeometry = baseModel.geometryResult;
    const headStore = headModel.ifcDataStore;
    const headGeometry = headModel.geometryResult;

    store.setCompareError(null);
    store.setCompareRunning(true);
    // Yield a frame so the "Comparing..." state paints before the (sync,
    // potentially heavy) fingerprint extraction blocks the main thread.
    await new Promise((resolve) => setTimeout(resolve, 0));

    try {
      // Reuse-if-current, extract otherwise, and re-check after the awaits.
      // Federation re-alignment re-frames meshes IN PLACE under these very ids,
      // so a run that started before it must not publish what it read across
      // it - the invalidation effect below would have cleared the panel, and
      // this run would put the stale answer straight back. Re-extracting rather
      // than abandoning is deliberate: the user pressed Run.
      const built = await buildAtCurrentVersion<BuiltPair>({
        readVersion: readGeometryContentVersion,
        cached: builtRef.current,
        isCurrent: (candidate, version) => isCurrentFor(candidate, baseId, headId, version),
        extract: async (contentVersion) => ({
          baseModelId: baseId,
          headModelId: headId,
          contentVersion,
          baseName: baseModel.name,
          headName: headModel.name,
          base: await buildEntityFingerprints({
            modelId: baseId,
            store: baseStore,
            meshes: baseGeometry.meshes,
            instancedGeometryHashes: baseGeometry.instancedGeometryHashes,
            instancedGeometryAabbs: baseGeometry.instancedGeometryAabbs,
            idOffset: baseModel.idOffset,
          }),
          head: await buildEntityFingerprints({
            modelId: headId,
            store: headStore,
            meshes: headGeometry.meshes,
            instancedGeometryHashes: headGeometry.instancedGeometryHashes,
            instancedGeometryAabbs: headGeometry.instancedGeometryAabbs,
            idOffset: headModel.idOffset,
          }),
        }),
      });
      if (!built) {
        // Never silently: `finally` clears the running flag, so returning with
        // no message would leave the panel blank after the user pressed Run.
        store.setCompareError(
          'The model geometry kept changing while comparing. Run the comparison again.',
        );
        return;
      }
      builtRef.current = built;

      // The diff options are read inside `publishCompareResult`, AFTER every
      // `await` above, and published atomically with it - see the invariant
      // documented on that function. Nothing here may capture them earlier.
      const { result: payload, matchByContent: ranMatchByContent } = publishCompareResult(built);

      // Per-kind match counts are the default-on rollout's evidence (#1891):
      // they say how often the pass fires in the field, and how much of what it
      // finds it resolves versus hands back for review.
      const matches = contentMatchCounts(payload.diff.contentMatches);
      posthog.capture('model_compare_run', {
        scope: payload.scope,
        changed_entity_count: payload.diff.entries.length,
        geometry_unavailable: payload.geometryUnavailable,
        excluded_type_count: payload.diff.excludedTypes.length,
        content_matching: ranMatchByContent,
        content_match_count: matches.total,
        content_matched_elements: matches.matchedElements,
        content_needs_review_elements: matches.needsReviewElements,
        content_match_renamed: matches.renamed,
        content_match_moved: matches.moved,
        content_match_reshaped: matches.reshaped,
        content_match_duplicated: matches.duplicated,
        content_match_deduplicated: matches.deduplicated,
        content_match_ambiguous: matches.ambiguous,
      });
    } catch (err) {
      console.error('[compare] comparison failed', err);
      store.setCompareError((err as Error).message ?? 'Comparison failed.');
      store.setCompareResult(null);
    } finally {
      store.setCompareRunning(false);
    }
  }, []);

  // Federation re-alignment re-frames vertices and their world boxes IN PLACE
  // (#1891), so a comparison published before it describes geometry that has
  // since moved and the cached fingerprints hold pre-alignment boxes. Retire
  // both. Clearing the RESULT as well as the cache is what keeps
  // `publishCompareResult`'s invariant intact: leaving a result on screen with
  // no usable fingerprints behind it would make the effect below early-return
  // on an option change, and the panel would disagree with its own controls -
  // exactly the staleness that function exists to prevent.
  //
  // Declared BEFORE the re-diff effect so a commit that changes both the
  // version and an option clears first. Seeded with the mounted value so a
  // remount is not mistaken for a bump; a re-align while this panel is
  // unmounted leaves no cache to reuse, and `runComparison` re-extracts.
  const lastContentVersionRef = useRef(geometryContentVersion);
  useEffect(() => {
    if (lastContentVersionRef.current === geometryContentVersion) return;
    lastContentVersionRef.current = geometryContentVersion;
    builtRef.current = null;
    useViewerStore.getState().clearCompare();
  }, [geometryContentVersion]);

  // Scope, blacklist OR content-matching change with an existing result for the
  // same pair -> re-diff from the cached fingerprints (instant). No-op when
  // nothing has been compared yet, or when none actually changed (equivalent
  // array refs). `contentMatches`' PRESENCE is the result's record of the flag
  // it ran with (see `contentMatchingRan`).
  //
  // This is only the change DETECTOR - the options it publishes are re-read from
  // the store by `publishCompareResult`, which is what makes the published
  // result agree with the store rather than with this render's props.
  //
  // `result` is deliberately NOT a dep - the effect writes it, so depending on
  // it would be a re-render/re-diff cycle guarded only by the equality checks
  // below. That omission is safe only because every publish reads these same
  // options at publish time: a result can never land carrying options older than
  // the ones this effect last saw, so there is nothing for a `result`-triggered
  // re-run to catch.
  useEffect(() => {
    const built = builtRef.current;
    if (!result || !built) return;
    if (!isCurrentFor(built, result.baseModelId, result.headModelId, geometryContentVersion)) return;
    const sameScope = result.scope === scope;
    const sameExcluded =
      excludedSignature(result.diff.excludedTypes) === excludedSignature(excludedTypes);
    const sameMatching = contentMatchingRan(result.diff.contentMatches) === matchByContent;
    if (sameScope && sameExcluded && sameMatching) return;

    publishCompareResult(built);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, excludedTypes, matchByContent]);

  return { baseModelId, headModelId, scope, running, result, error, runComparison };
}
