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
import { cancelCompareRun } from './analysisRunCancellation';
import { stampAnalysisReport } from './useAnalysisStaleness';
import { diffModels, type EntityFingerprint } from '@ifc-lite/diff';
import { useViewerStore } from '@/store';
import { posthog } from '@/lib/analytics';
import type { CompareResult } from '@/store/slices/compareSlice';
import { buildEntityFingerprints, type CompareRef } from '@/lib/compare/buildFingerprints';
import { effectiveComparePair } from '@/lib/compare/effectiveCompareStore';
import { useInvalidateCompareCacheOnEdit } from './compare/useInvalidateCompareCacheOnEdit';
import { fallbackPairDuplicateAuthoredKeys } from '@/lib/compare/authoredKeys';
import {
  geometryVolumesSurviveAlignment,
  resolveGeometryChannel,
} from '@/lib/compare/geometryCapability';
import { contentMatchingRan } from '@/lib/compare/contentMatches';
import { acceptedForPair, keyAliasesFromAccepted } from '@/lib/compare/acceptedIdentity';
import { compareRunPayload } from '@/lib/compare/runTelemetry';
import { buildAtCurrentVersion } from '@/lib/compare/versionedBuild';
import { isCurrentFor, readGeometryContentVersion, type BuiltPair } from './compare/comparePairCache';

// Re-exported so existing consumers (`useCompare.test.ts`) see no change —
// the cache key itself moved to `compare/comparePairCache.ts` for the
// module-size house rule (AGENTS.md).
export { isCurrentFor, readGeometryContentVersion };

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
  const accepted = acceptedForPair(store.compareAcceptedIdentity, built); // this pair's only

  // The strip decision, the warning flag and its placement-only nuance are ONE
  // resolution (`resolveGeometryChannel`), so the panel's warning can never
  // disagree with what the engine was actually given: a MIXED-capability pair
  // (one side mesh-hashed) has placement fingerprints stripped from both sides
  // so the engine's asymmetry abstention can fire; a symmetric mesh-less pair
  // keeps them, still reports placement-driven moves, and the warning must say
  // reshapes-only.
  const {
    base,
    head,
    geometryUnavailable,
    placementOnlyGeometry,
  } = resolveGeometryChannel(built.base, built.head);

  const diff = diffModels(base, head, {
    scope,
    excludeTypes: excludedTypes,
    // #1891. On by default: a from-scratch re-export re-GUIDs every element,
    // and a pure key diff then reports the entire model as deleted-and-added.
    // The world `aabb` rides on the fingerprints (#2005), so a 1:1 geometry
    // mismatch reports a real distance; an entity the wasm pass produced no box
    // for still degrades to a bare `moved`, the engine's documented fallback.
    matchUnpairedByContent: matchByContent,
    // #4955. Suggestions, never decisions: neither stage retires an entry or
    // touches a count, and both abstain with the content pass when a side has
    // no geometry. The panel's Suggestions section lists what they found.
    detectSplitMerge: true,
    detectSuccessors: true,
    // The pairs the user accepted (or imported) this session, replayed so
    // they classify by key and leave the suggestions. Read HERE with the
    // other options, under the same no-await rule.
    keyAliases: keyAliasesFromAccepted(accepted),
  });
  const result: CompareResult = {
    baseModelId: built.baseModelId,
    headModelId: built.headModelId,
    baseName: built.baseName,
    headName: built.headName,
    scope,
    geometryUnavailable,
    placementOnlyGeometry,
    excludedHiddenIds: collectExcludedHiddenIds(built, excludedTypes),
    diff,
    // #4989: the scheme THIS extraction ran under, not whatever the store
    // holds now — see the doc comment on `BuiltPair.keyProperty`.
    keyProperty: built.keyProperty,
    duplicateAuthoredKeys: built.duplicateAuthoredKeys.size > 0 ? built.duplicateAuthoredKeys : undefined,
    comparedStores: built.comparedStores.size > 0 ? built.comparedStores : undefined,
    mutationVersion: built.mutationVersion,
  };
  store.setCompareResult(stampAnalysisReport(result, {
    mutationVersion: built.mutationVersion,
    geometryContentVersion: built.contentVersion,
  }));
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
  const acceptedIdentity = useViewerStore((s) => s.compareAcceptedIdentity);
  const running = useViewerStore((s) => s.compareRunning);
  const result = useViewerStore((s) => s.compareResult);
  const error = useViewerStore((s) => s.compareError);
  const geometryContentVersion = useViewerStore((s) => s.geometryContentVersion);

  // Cache the built fingerprints for the current pair so a scope / blacklist
  // change is a cheap re-diff rather than a full re-extraction.
  const builtRef = useRef<BuiltPair | null>(null);

  /**
   * Supersession epoch for `runComparison()` itself (#2802 sweep).
   *
   * `isCurrentFor` / `buildAtCurrentVersion` protect the fingerprint CACHE
   * against a federation re-alignment; they say nothing about whether THIS
   * `runComparison()` call is still the one whose answer the user wants. Two
   * gaps that check cannot see:
   *
   * - A newer `runComparison()` call (same pair or a different one, started
   *   after the user changed the selection) must win over an older one still
   *   finishing its extraction, regardless of which resolves first.
   * - An explicit `clearCompare()` mid-flight must stick - a run that was
   *   already in the air when the user cleared must not resurrect the result
   *   they just dismissed.
   *
   * Bumped on run, clear and cancel. Every post-await store write re-checks
   * its captured epoch immediately before writing - never
   * earlier, so nothing can supersede between the check and the write.
   */
  const epochRef = useRef(0);

  /** Bump the epoch and clear, so an in-flight run's `then`/`catch` cannot
   *  write the result the user just dismissed back into the store. Routes
   *  through here rather than the raw store action for every caller in this
   *  file and in `ComparePanel` - a `clearCompare()` invoked directly on the
   *  store instead of through this wrapper would not be seen. */
  const clearCompare = useCallback(() => {
    epochRef.current += 1;
    useViewerStore.getState().clearCompare();
  }, []);

  const cancelComparison = useCallback(() => cancelCompareRun(epochRef), []);

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

    // Captured with the pair, before any await (#4989): this drives what the
    // fingerprints extracted below are keyed on, and must not drift mid-run
    // — see the doc comment on `BuiltPair.keyProperty`.
    const keyProperty = store.compareKeyProperty;

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

    // Supersedes any run already in flight (same pair or not) - see the epoch
    // doc comment above. Captured once; re-checked at every write below.
    const myEpoch = ++epochRef.current;

    /** Is THIS run still the one whose answer the user is waiting on? Both
     *  conjuncts matter and neither alone is enough: the epoch alone misses a
     *  selection change that never triggers a second `runComparison()` call
     *  (scenario 3 - #2802), and the pair-match alone misses a `clearCompare()`
     *  that leaves the pair untouched (scenario 2 - #2802, `clearCompare`
     *  "keeps the A/B + scope choices" by design). Read fresh, never cached -
     *  the whole point is to observe the store as it is right now. */
    const stillWanted = (): boolean => {
      if (epochRef.current !== myEpoch) return false;
      const live = useViewerStore.getState();
      return live.compareBaseModelId === baseId
        && live.compareHeadModelId === headId
        && live.compareKeyProperty === keyProperty;
    };

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
        isCurrent: (candidate, version) => isCurrentFor(candidate, baseId, headId, version, keyProperty),
        extract: async (contentVersion) => {
          // ONE collision map for both sides (#4989): if either revision
          // duplicates a value, the pair-level fallback below retires that
          // authored key from both revisions before diffing.
          const duplicateAuthoredKeys = new Map<string, number[]>();
          // The models as edited, not as loaded (#5312): see effectiveCompareStore.
          const mutationVersion = useViewerStore.getState().mutationVersion;
          const { baseEffective, headEffective, comparedStores } = await effectiveComparePair(
            [baseModel, baseStore], [headModel, headStore], useViewerStore.getState().getMutationView);
          const base = await buildEntityFingerprints({
            modelId: baseId,
            store: baseEffective,
            meshes: baseGeometry.meshes,
            instancedGeometryHashes: baseGeometry.instancedGeometryHashes,
            instancedGeometryAabbs: baseGeometry.instancedGeometryAabbs,
            instancedGeometryVolumes: baseGeometry.instancedGeometryVolumes,
            geometryVolumesTrusted: geometryVolumesSurviveAlignment(
              baseModel.federationAlignmentStatus,
            ),
            idOffset: baseModel.idOffset,
            keyProperty,
            duplicateAuthoredKeys,
          });
          const head = await buildEntityFingerprints({
            modelId: headId,
            store: headEffective,
            meshes: headGeometry.meshes,
            instancedGeometryHashes: headGeometry.instancedGeometryHashes,
            instancedGeometryAabbs: headGeometry.instancedGeometryAabbs,
            instancedGeometryVolumes: headGeometry.instancedGeometryVolumes,
            geometryVolumesTrusted: geometryVolumesSurviveAlignment(
              headModel.federationAlignmentStatus,
            ),
            idOffset: headModel.idOffset,
            keyProperty,
            duplicateAuthoredKeys,
          });
          fallbackPairDuplicateAuthoredKeys([
            { fingerprints: base, store: baseEffective },
            { fingerprints: head, store: headEffective },
          ], duplicateAuthoredKeys);
          return {
            comparedStores,
            mutationVersion,
            baseModelId: baseId,
            headModelId: headId,
            contentVersion,
            keyProperty,
            duplicateAuthoredKeys,
            baseName: baseModel.name,
            headName: headModel.name,
            base,
            head,
          };
        },
      });
      if (!built) {
        // Never silently: `finally` clears the running flag, so returning with
        // no message would leave the panel blank after the user pressed Run -
        // but only when this run is still the one the user is waiting on; a
        // superseded run reporting its own failure into a newer run's state
        // is the scenario-5 clobber (#2802).
        if (stillWanted()) {
          store.setCompareError(
            'The model geometry kept changing while comparing. Run the comparison again.',
          );
        }
        return;
      }

      // Re-checked immediately before every write below, synchronously with no
      // `await` in between - see the epoch doc comment above. A run that lost
      // the race (a newer run started, the pair changed, or the user cleared)
      // must publish nothing: not the result, not its cache entry either,
      // since a stale cache entry for a pair that is no longer selected would
      // silently defeat the reconciliation effect's `isCurrentFor` check on
      // the NEXT option change (see that effect's comment).
      if (!stillWanted()) return;
      builtRef.current = built;

      // The diff options are read inside `publishCompareResult`, AFTER every
      // `await` above, and published atomically with it - see the invariant
      // documented on that function. Nothing here may capture them earlier.
      const { result: payload, matchByContent: ranMatchByContent } = publishCompareResult(built);

      posthog.capture('model_compare_run', compareRunPayload(payload, ranMatchByContent));
    } catch (err) {
      console.error('[compare] comparison failed', err);
      // Same guard as above: a superseded run's own failure must set an error
      // state for a run nobody is waiting on, not clobber whatever a newer
      // run already published (#2802 scenario 5).
      if (stillWanted()) {
        store.setCompareError((err as Error).message ?? 'Comparison failed.');
        store.setCompareResult(null);
      }
    } finally {
      // A superseded run's `finally` must not flip `compareRunning` back to
      // false out from under a newer run that owns it now (or that
      // `clearCompare` already set it false for) - whichever run IS still
      // wanted controls the flag via its own `finally`.
      if (epochRef.current === myEpoch) {
        store.setCompareRunning(false);
      }
    }
  }, []);

  // A geometry re-alignment invalidates cached fingerprints. Keep the result
  // visible with a stale banner until the user re-runs; the option re-diff
  // below refuses to reuse the retired cache.
  //
  // Declared BEFORE the re-diff effect so a commit that changes both the
  // version and an option invalidates the cache first. Seeded with the mounted
  // value so a remount is not mistaken for a bump; a re-align while unmounted
  // leaves no cache to reuse, and `runComparison` re-extracts.
  const lastContentVersionRef = useRef(geometryContentVersion);
  // The accepted list a published result was diffed with. `appliedKeyAliases`
  // cannot stand in for it: an accepted pair the engine ignored (key not in
  // the base) leaves no trace there, and the effect would re-publish forever.
  const lastAcceptedRef = useRef(acceptedIdentity);
  useEffect(() => {
    if (lastContentVersionRef.current === geometryContentVersion) return;
    lastContentVersionRef.current = geometryContentVersion;
    builtRef.current = null;
  }, [geometryContentVersion]);
  useInvalidateCompareCacheOnEdit(builtRef);

  // Scope, blacklist, content-matching OR accepted-identity change with an
  // existing result for the same pair -> re-diff from the cached fingerprints
  // (instant). No-op when nothing has been compared yet, or when none actually
  // changed (equivalent array refs). `contentMatches`' PRESENCE is the result's
  // record of the flag it ran with (see `contentMatchingRan`); the accepted
  // list is compared by reference, which the slice keeps stable on a no-op.
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
    if (!isCurrentFor(built, result.baseModelId, result.headModelId, geometryContentVersion, result.keyProperty)) return;
    const sameScope = result.scope === scope;
    const sameExcluded =
      excludedSignature(result.diff.excludedTypes) === excludedSignature(excludedTypes);
    const sameMatching = contentMatchingRan(result.diff.contentMatches) === matchByContent;
    const sameAccepted = lastAcceptedRef.current === acceptedIdentity;
    if (sameScope && sameExcluded && sameMatching && sameAccepted) return;

    lastAcceptedRef.current = acceptedIdentity;
    publishCompareResult(built);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, excludedTypes, matchByContent, acceptedIdentity]);

  return { baseModelId, headModelId, scope, running, result, error, runComparison, cancelComparison, clearCompare };
}
