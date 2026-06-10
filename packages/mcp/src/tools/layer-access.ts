/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ownership / visibility gating for the layer workspace (#1030).
 *
 * Access matrix. A record's `owner` is the creating principal; undefined
 * (unauthenticated/local) means anyone:
 *
 *   - drafts: session-private storage; mutations (draft_apply_ops,
 *     publish_layer) are owner-only on top of that.
 *   - published layers / refs: process-shared, readable by every session
 *     (immutable, content-addressed; ref policies are registry work).
 *   - reviews: process-shared so reviewers can act on them from their own
 *     sessions. Visible to the owner and listed reviewers only —
 *     including reads (get_review_feedback), since the store spans
 *     principals. respond_to_review is owner-only; add_review_feedback
 *     admits owner or listed reviewers.
 *
 * Denials are byte-identical to the unknown-id error, and error `details`
 * only enumerate ids the caller may see — a foreign id must be
 * indistinguishable from a nonexistent one.
 */

import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import type { DraftLayer, LayerReview, LayerWorkspace } from './layer-store.js';

function visibleTo(owner: string | undefined, caller: string | undefined): boolean {
  return owner === undefined || owner === caller;
}

function reviewVisibleTo(review: LayerReview, caller: string | undefined): boolean {
  if (visibleTo(review.owner, caller)) return true;
  return caller !== undefined && review.reviewers.includes(caller);
}

export function visibleDraftIds(ws: LayerWorkspace, caller?: string): string[] {
  return Array.from(ws.drafts.values())
    .filter((d) => visibleTo(d.owner, caller))
    .map((d) => d.id);
}

export function visibleReviewIds(ws: LayerWorkspace, caller?: string): string[] {
  return Array.from(ws.reviews.values())
    .filter((r) => reviewVisibleTo(r, caller))
    .map((r) => r.id);
}

function unknownDraftError(ws: LayerWorkspace, id: string, caller?: string): ToolExecutionError {
  return new ToolExecutionError({
    code: ToolErrorCode.ENTITY_NOT_FOUND,
    message: `Unknown draft '${id}'. Call create_draft_layer first.`,
    details: { drafts: visibleDraftIds(ws, caller) },
  });
}

function unknownReviewError(ws: LayerWorkspace, id: string, caller?: string): ToolExecutionError {
  return new ToolExecutionError({
    code: ToolErrorCode.ENTITY_NOT_FOUND,
    message: `Unknown review '${id}'.`,
    details: { reviews: visibleReviewIds(ws, caller) },
  });
}

/** Existence check only — read paths; `caller` just filters error details. */
export function requireDraft(ws: LayerWorkspace, id: string, caller?: string): DraftLayer {
  const draft = ws.drafts.get(id);
  if (!draft) throw unknownDraftError(ws, id, caller);
  return draft;
}

/** Ownership-gated lookup for mutating draft tools. */
export function requireOwnedDraft(ws: LayerWorkspace, id: string, caller?: string): DraftLayer {
  const draft = requireDraft(ws, id, caller);
  if (!visibleTo(draft.owner, caller)) throw unknownDraftError(ws, id, caller);
  return draft;
}

/**
 * Visibility-gated lookup for review reads: reviews span principals
 * (process-shared), so even reads admit only the owner and listed
 * reviewers. Denial is identical to the unknown-id error.
 */
export function requireReview(ws: LayerWorkspace, id: string, caller?: string): LayerReview {
  const review = ws.reviews.get(id);
  if (!review || !reviewVisibleTo(review, caller)) throw unknownReviewError(ws, id, caller);
  return review;
}

/** Ownership-gated lookup for mutating review tools. */
export function requireOwnedReview(
  ws: LayerWorkspace,
  id: string,
  caller?: string,
  opts: { allowReviewers?: boolean } = {},
): LayerReview {
  const review = requireReview(ws, id, caller);
  const reviewerAllowed =
    opts.allowReviewers === true && caller !== undefined && review.reviewers.includes(caller);
  if (!visibleTo(review.owner, caller) && !reviewerAllowed) {
    throw unknownReviewError(ws, id, caller);
  }
  return review;
}
