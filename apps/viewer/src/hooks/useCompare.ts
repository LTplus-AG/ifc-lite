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
 * `DiffModelHandle.compare` pass.
 *
 * Mirrors `useClash`: the slice holds dumb state, the hook does the work.
 */

import { useCallback, useEffect, useRef } from 'react';
import { isNativeWorkflowBusy } from '@/lib/flow/run-session';
import { cancelCompareRun, invalidateAbortableRun, releaseAbortableRun, startAbortableRun } from './analysisRunCancellation';
import { useViewerStore } from '@/store';
import { posthog } from '@/lib/analytics';
import { useComparePairCache } from './compare/useComparePairCache';
import { contentMatchingRan } from '@/lib/compare/contentMatches';
import { compareRunPayload } from '@/lib/compare/runTelemetry';
import { publishCompareResult } from '@/lib/compare/publish-comparison';
import { prepareComparison } from '@/lib/compare/run-comparison';
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
  /** The in-flight extraction, aborted with every epoch bump (A2). */
  const abortRef = useRef<AbortController | null>(null);
  const builtRef = useComparePairCache(epochRef, abortRef);

  /** Bump the epoch and clear, so an in-flight run's `then`/`catch` cannot
   *  write the result the user just dismissed back into the store. Routes
   *  through here rather than the raw store action for every caller in this
   *  file and in `ComparePanel`; the cache subscription also observes raw
   *  store clears and workspace teardown. */
  const clearCompare = useCallback(() => {
    invalidateAbortableRun(epochRef, abortRef);
    builtRef.current?.dispose();
    builtRef.current = null;
    useViewerStore.getState().clearCompare();
  }, [builtRef]);

  const cancelComparison = useCallback(() => {
    builtRef.current?.dispose();
    builtRef.current = null;
    cancelCompareRun(epochRef, abortRef);
    // Without cached handles, option changes cannot reconcile the old result.
    useViewerStore.getState().setCompareResult(null);
  }, [builtRef]);

  const runComparison = useCallback(async () => {
    const store = useViewerStore.getState();
    if (isNativeWorkflowBusy()) {
      store.setCompareError('A workflow is running; wait or cancel it.');
      return;
    }
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

    // Supersedes any run already in flight (same pair or not) - see the epoch
    // doc comment above. Captured once; re-checked at every write below.
    const { runEpoch: myEpoch, controller } = startAbortableRun(epochRef, abortRef);

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
      if (!stillWanted()) return;
      const current = (candidate: BuiltPair, version: number) =>
        isCurrentFor(candidate, baseId, headId, version, keyProperty);
      if (builtRef.current && !current(builtRef.current, readGeometryContentVersion())) {
        builtRef.current.dispose();
        builtRef.current = null;
      }
      // Reuse-if-current, extract otherwise, and re-check after the awaits.
      // Federation re-alignment re-frames meshes IN PLACE under these very ids,
      // so a run that started before it must not publish what it read across
      // it - invalidation retires the cache while keeping the previous result
      // visible with a stale banner. Re-extracting rather
      // than abandoning is deliberate: the user pressed Run.
      // Never borrow the cached native handles across an await: store changes
      // can dispose them synchronously. Only new, locally owned builds await.
      const built = builtRef.current ?? await buildAtCurrentVersion<BuiltPair>({
        readVersion: readGeometryContentVersion,
        cached: null,
        isCurrent: current,
        discard: (candidate) => candidate.dispose(),
        extract: async (contentVersion) => {
          return prepareComparison({ baseModel, headModel, contentVersion, keyProperty,
            mutationVersion: useViewerStore.getState().mutationVersion,
            getMutationView: useViewerStore.getState().getMutationView, signal: controller.signal });
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
      if (!stillWanted()) {
        built.dispose();
        return;
      }
      if (!current(built, readGeometryContentVersion())) {
        built.dispose();
        store.setCompareError('The model geometry kept changing while comparing. Run the comparison again.');
        return;
      }
      if (builtRef.current !== built) builtRef.current?.dispose();
      builtRef.current = built;

      // The diff options are read inside `publishCompareResult`, AFTER every
      // `await` above, and published atomically with it - see the invariant
      // documented on that function. Nothing here may capture them earlier.
      const { result: payload, matchByContent: ranMatchByContent } = publishCompareResult(built);

      posthog.capture('model_compare_run', compareRunPayload(payload, ranMatchByContent));
    } catch (err) {
      // Aborted by an epoch bump: superseded, cleared or torn down, which is
      // how such a run is meant to end — nothing to report.
      if (controller.signal.aborted) return;
      console.error('[compare] comparison failed', err);
      // Same guard as above: a superseded run's own failure must set an error
      // state for a run nobody is waiting on, not clobber whatever a newer
      // run already published (#2802 scenario 5).
      if (stillWanted()) {
        store.setCompareError((err as Error).message ?? 'Comparison failed.');
        store.setCompareResult(null);
      }
    } finally {
      releaseAbortableRun(controller, abortRef);
      // A superseded run's `finally` must not flip `compareRunning` back to
      // false out from under a newer run that owns it now (or that
      // `clearCompare` already set it false for) - whichever run IS still
      // wanted controls the flag via its own `finally`.
      if (epochRef.current === myEpoch) {
        store.setCompareRunning(false);
      }
    }
  }, [builtRef]);

  // The accepted list a published result was diffed with. `appliedKeyAliases`
  // cannot stand in for it: an accepted pair the engine ignored (key not in
  // the base) leaves no trace there, and the effect would re-publish forever.
  const lastAcceptedRef = useRef(acceptedIdentity);
  // The options this effect last ran with, to tell a real change from a mount.
  const lastOptionsRef = useRef({ scope, excludedTypes, matchByContent });

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
    const previous = lastOptionsRef.current;
    lastOptionsRef.current = { scope, excludedTypes, matchByContent };
    // The panel controls the result's counts depend on. Accepting an identity
    // suggestion is a review decision recorded on its own, not a control change.
    const optionChanged = previous.scope !== scope || previous.excludedTypes !== excludedTypes
      || previous.matchByContent !== matchByContent;
    if (!result) return;
    const sameScope = result.scope === scope;
    const sameExcluded =
      excludedSignature(result.diff.excludedTypes) === excludedSignature(excludedTypes);
    const sameMatching = contentMatchingRan(result.diff.contentMatches) === matchByContent;
    const sameAccepted = lastAcceptedRef.current === acceptedIdentity;
    if (sameScope && sameExcluded && sameMatching && sameAccepted) return;
    if (!built || !isCurrentFor(built, result.baseModelId, result.headModelId, geometryContentVersion, result.keyProperty)) {
      // No cached pair for this result (an agent compare.run publishes from its
      // own extraction), so it cannot be re-diffed. When the user then changes
      // an option, drop it rather than show counts that disagree with the
      // controls, as cancelComparison does. A result merely mounted with other
      // options (a retained stale comparison) is kept.
      if (optionChanged) useViewerStore.getState().setCompareResult(null);
      return;
    }

    lastAcceptedRef.current = acceptedIdentity;
    publishCompareResult(built);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, excludedTypes, matchByContent, acceptedIdentity]);

  return { baseModelId, headModelId, scope, running, result, error, runComparison, cancelComparison, clearCompare };
}
