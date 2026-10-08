/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reviewed semantic mappings and extracted requirement sets, stored as the
 * native content kind `semanticReviews` (reload, backup, import, recovery).
 * The semantic workspace has no structure for IFC↔ontology mappings or
 * requirement spans, so it is left untouched. Entries keep the strict
 * proposal plus the review decisions; a mapping keeps its revision pin and is
 * shown as historical once that revision context changes.
 */

import { create } from 'zustand';
import { createContentLibrary, initialContentStatus, type ContentStatus } from '@/lib/storage/content-library';
import type { ContentDefinition } from '@/lib/storage/content-migration';
import type { SemanticMappingProposal } from './mapping-proposal';
import type { SemanticRequirementProposal } from './requirement-proposal';
import { decodeRevisionPin, type RevisionPin } from './revision-pin-schema';
import type { SpanCheck } from './spans';

interface ReviewBase { version: 1; id: string; createdAt: string; origin: string }
type MappingFields = { type: 'mapping'; profile: { id: string; version: string; identity?: string }; pin: RevisionPin; approved: number[] };
type RequirementFields = { type: 'requirements'; spans: Array<SpanCheck['status']>; unsupportedSpans: Array<SpanCheck['status'] | null> };
/**
 * What the content library holds: the envelope and the review decisions are
 * checked on every read, the proposal itself stays opaque JSON. The strict
 * proposal decoders live in `review-validate.ts` and load with the cards that
 * need them, so the eager storage chunk carries none of that parsing.
 */
export type StoredSemanticReview =
  | ReviewBase & MappingFields & { proposal: unknown }
  | ReviewBase & RequirementFields & { proposal: unknown };
/** A stored review whose proposal passed the strict decoders. */
export type SavedSemanticReview =
  | ReviewBase & MappingFields & { proposal: SemanticMappingProposal }
  | ReviewBase & RequirementFields & { proposal: SemanticRequirementProposal };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const SPAN_STATUSES = new Set(['verified', 'mismatch', 'not-captured']);

export function decodeSemanticReview(value: unknown): StoredSemanticReview | null {
  if (!record(value) || value.version !== 1 || typeof value.id !== 'string' || !value.id || typeof value.createdAt !== 'string'
    || typeof value.origin !== 'string' || !record(value.proposal)) return null;
  const base: ReviewBase = { version: 1, id: value.id, createdAt: value.createdAt, origin: value.origin };
  const proposal = structuredClone(value.proposal);
  if (value.type === 'mapping') {
    const pin = decodeRevisionPin(value.pin);
    if (!pin || !record(value.profile) || typeof value.profile.id !== 'string' || typeof value.profile.version !== 'string'
      || (value.profile.identity !== undefined && typeof value.profile.identity !== 'string')
      || !Array.isArray(value.approved) || !value.approved.length || value.approved.length > 200
      || !value.approved.every(index => Number.isInteger(index) && index >= 0) || new Set(value.approved).size !== value.approved.length) return null;
    return { ...base, type: 'mapping', profile: { id: value.profile.id, version: value.profile.version, ...(typeof value.profile.identity === 'string' ? { identity: value.profile.identity } : {}) }, pin, proposal, approved: [...value.approved] as number[] };
  }
  if (value.type === 'requirements') {
    if (!Array.isArray(value.spans) || value.spans.length > 200 || !value.spans.every(status => SPAN_STATUSES.has(String(status)))
      || !Array.isArray(value.unsupportedSpans) || value.unsupportedSpans.length > 100
      || !value.unsupportedSpans.every(status => status === null || SPAN_STATUSES.has(String(status)))) return null;
    return { ...base, type: 'requirements', proposal, spans: [...value.spans] as Array<SpanCheck['status']>,
      unsupportedSpans: [...value.unsupportedSpans] as Array<SpanCheck['status'] | null> };
  }
  return null;
}

export const semanticReviewContent: ContentDefinition<StoredSemanticReview> = {
  kind: 'semanticReviews', legacyKey: 'ifc-lite-semantic-reviews-v1', decode: decodeSemanticReview,
};

export const useSemanticReviews = create<{ entries: StoredSemanticReview[]; status: ContentStatus }>(
  () => ({ entries: [], status: initialContentStatus() }));
export const semanticReviewLibrary = createContentLibrary(semanticReviewContent,
  () => useSemanticReviews.getState().entries,
  (entries, status) => useSemanticReviews.setState({ entries, status }));

export function saveSemanticReview(entry: SavedSemanticReview): Promise<boolean> {
  const decoded = decodeSemanticReview(JSON.parse(JSON.stringify(entry)));
  if (!decoded) return Promise.reject(new Error('The review cannot be saved: it failed validation'));
  return semanticReviewLibrary.put(decoded.id, decoded);
}
