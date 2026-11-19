/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { CompareResult } from '@/store/slices/compareSlice';
import type { BuiltPair } from '@/hooks/compare/comparePairCache';
import { useViewerStore } from '@/store';
import { acceptedForPair } from './acceptedIdentity';
import { comparePreparedPair } from './run-comparison';
import { stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
/**
 * Run the (cheap) diff pass for the cached fingerprints, derive the overlay's
 * hidden set, and publish the whole comparison to the store. The single place a
 * `CompareResult` is ever produced - both the Run button and the reconciliation
 * effect in useCompare go through here.
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
 * Together those are what let the reconciliation effect in useCompare omit `result` from
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
export function publishCompareResult(built: BuiltPair): {
  result: CompareResult;
  matchByContent: boolean;
} {
  const store = useViewerStore.getState();
  const scope: CompareResult['scope'] = store.compareScope;
  const excludedTypes = store.compareExcludedTypes;
  const matchByContent = store.compareMatchByContent;
  const accepted = acceptedForPair(store.compareAcceptedIdentity, built); // this pair's only

  const result = comparePreparedPair(built, { scope, excludedTypes, matchByContent, acceptedIdentity: accepted });
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
