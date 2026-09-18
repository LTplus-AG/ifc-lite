/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Compare panel's suggestion rows and the two decisions a user can make
 * on one (issue #4955). Kept out of `ComparePanel` for the module-size house
 * rule; the rules themselves live in `lib/compare/suggestions.ts` and
 * `lib/compare/acceptedIdentity.ts`, this is the store glue.
 *
 * Accept writes an identity-map entry into the store. `useCompare`'s
 * reconciliation effect sees the new list, re-diffs from the cached
 * fingerprints with it as `keyAliases`, and the pair leaves the suggestions
 * classified by key. The row is hidden on the click itself (the accepted
 * signature is filtered out of the rows), so it never lingers for a render.
 */

import { useMemo } from 'react';
import { ACCEPTED_AMBIGUOUS_REASON, SUCCESSOR_REASON_PREFIX } from '@ifc-lite/diff';
import { useViewerStore } from '@/store';
import { posthog } from '@/lib/analytics';
import type { CompareResult } from '@/store/slices/compareSlice';
import type { CompareRef } from '@/lib/compare/buildFingerprints';
import { acceptedSignatures } from '@/lib/compare/acceptedIdentity';
import { claimDecisionPayload } from '@/lib/compare/runTelemetry';
import { suggestionRows, type SuggestionRow } from '@/lib/compare/suggestions';
import type { SuggestionDecision } from './CompareSuggestions';

export function useCompareSuggestions(
  result: CompareResult | null,
  nameOf: (ref: CompareRef) => string,
): {
  suggestions: SuggestionRow[];
  accepted: ReadonlySet<string>;
  rejected: ReadonlySet<string>;
  accept: (decision: SuggestionDecision) => void;
  reject: (decision: SuggestionDecision) => void;
} {
  const acceptedEntries = useViewerStore((s) => s.compareAcceptedIdentity);
  const rejected = useViewerStore((s) => s.compareRejectedClaims);
  const accepted = useMemo(() => acceptedSignatures(acceptedEntries), [acceptedEntries]);

  const suggestions = useMemo(
    () =>
      result
        ? suggestionRows(
            {
              successors: result.diff.successors,
              splitMerges: result.diff.splitMerges,
              contentMatches: result.diff.contentMatches,
              accepted,
              rejected,
            },
            nameOf,
          )
        : [],
    // `nameOf` is a fresh closure per render over the same `models`; the rows
    // only change with the result or a decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, accepted, rejected],
  );

  const decision = (d: SuggestionDecision): { kind: 'successor' | 'ambiguous'; reason: string } =>
    d.row.kind === 'successor'
      ? { kind: 'successor', reason: `${SUCCESSOR_REASON_PREFIX}${d.row.confidence}` }
      : { kind: 'ambiguous', reason: ACCEPTED_AMBIGUOUS_REASON };

  const accept = (d: SuggestionDecision) => {
    const { kind, reason } = decision(d);
    const store = useViewerStore.getState();
    const refused = store.acceptCompareIdentity([{ base: d.base, here: d.here, reason }]);
    if (refused.length > 0) {
      store.setCompareError(`${d.base} or ${d.here} is already part of an accepted pair.`);
      return;
    }
    if (store.compareSelectedKey === d.row.key) store.setCompareSelectedKey(null);
    posthog.capture('model_compare_claim_accept', claimDecisionPayload(kind, reason, d.row.confidence));
  };

  const reject = (d: SuggestionDecision) => {
    const { kind, reason } = decision(d);
    const store = useViewerStore.getState();
    store.rejectCompareClaim(d.base, d.here);
    if (store.compareSelectedKey === d.row.key) store.setCompareSelectedKey(null);
    posthog.capture('model_compare_claim_reject', claimDecisionPayload(kind, reason, d.row.confidence));
  };

  return { suggestions, accepted, rejected, accept, reject };
}
