/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PostHog payloads for the Compare panel, in one place so the run event and
 * the export event count the same things the same way.
 *
 * Per-kind match counts are the default-on rollout's evidence (#1891): they
 * say how often the content pass fires in the field, and how much of what it
 * finds it resolves versus hands back for review. The claim counts (#4955)
 * are the same evidence for the suggestion stages: how often a replaced-in-
 * place or a split is offered, and (via the accept / reject events) how
 * often a human agrees.
 */

import type { ModelDiff, SuccessorConfidence } from '@ifc-lite/diff';
import type { CompareRef } from './buildFingerprints.js';
import type { CompareResult } from '../../store/slices/compareSlice.js';
import { contentMatchCounts } from './contentMatches.js';
import { productTypeSplit } from './productTypeCounts.js';

/** How many suggestions each stage produced. `0` both when the stage ran and
 *  found nothing and when it abstained (no geometry). */
export function claimCounts(diff: ModelDiff<CompareRef>): {
  successorClaims: number;
  splitMergeClaims: number;
} {
  return {
    successorClaims: diff.successors?.length ?? 0,
    splitMergeClaims: diff.splitMerges?.length ?? 0,
  };
}

/** The `model_compare_run` payload. `matchByContent` is the OPTION the run
 *  was given, of which `diff.contentMatches` is only a derivation. */
export function compareRunPayload(
  result: CompareResult,
  matchByContent: boolean,
): Record<string, unknown> {
  const matches = contentMatchCounts(result.diff.contentMatches);
  // Products vs type objects (headline-count confusion, see
  // `productTypeCounts.ts`): the field's evidence for how often a run's
  // engine-wide counts actually include type-object changes.
  const split = productTypeSplit(result.diff.entries);
  const claims = claimCounts(result.diff);
  return {
    scope: result.scope,
    changed_entity_count: result.diff.entries.length,
    geometry_unavailable: result.geometryUnavailable,
    excluded_type_count: result.diff.excludedTypes.length,
    content_matching: matchByContent,
    content_match_count: matches.total,
    content_matched_elements: matches.matchedElements,
    content_needs_review_elements: matches.needsReviewElements,
    content_match_renamed: matches.renamed,
    content_match_moved: matches.moved,
    content_match_reshaped: matches.reshaped,
    content_match_respecified: matches.respecified,
    content_match_duplicated: matches.duplicated,
    content_match_deduplicated: matches.deduplicated,
    content_match_ambiguous: matches.ambiguous,
    successor_claims: claims.successorClaims,
    split_merge_claims: claims.splitMergeClaims,
    accepted_identity_count: result.diff.appliedKeyAliases?.size ?? 0,
    product_added: split.products.added,
    product_modified: split.products.modified,
    product_deleted: split.products.deleted,
    type_object_added: split.typeObjects.added,
    type_object_modified: split.typeObjects.modified,
    type_object_deleted: split.typeObjects.deleted,
  };
}

/** The `model_compare_export` payload, for the report AND the sidecars. */
export function compareExportPayload(
  format: 'csv' | 'json' | 'identity-map' | 'lineage',
  result: CompareResult,
): Record<string, unknown> {
  const c = result.diff.counts;
  const matches = contentMatchCounts(result.diff.contentMatches);
  const claims = claimCounts(result.diff);
  return {
    format,
    scope: result.scope,
    row_count: c.added + c.modified + c.deleted,
    content_match_respecified: matches.respecified,
    successor_claims: claims.successorClaims,
    split_merge_claims: claims.splitMergeClaims,
  };
}

/** The `model_compare_claim_accept` / `model_compare_claim_reject` payload. */
export function claimDecisionPayload(
  kind: 'successor' | 'ambiguous',
  reason: string,
  confidence?: SuccessorConfidence,
): Record<string, unknown> {
  return confidence === undefined ? { kind, reason } : { kind, confidence, reason };
}
