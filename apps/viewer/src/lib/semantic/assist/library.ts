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
import { parseSemanticMapping, type SemanticMappingProposal } from './mapping-proposal';
import { parseSemanticRequirements, type SemanticRequirementProposal } from './requirement-proposal';
import { decodeRevisionPin, type RevisionPin } from './revision-pin';
import type { SpanCheck } from './spans';

interface ReviewBase { version: 1; id: string; createdAt: string; origin: string }
export type SavedSemanticReview =
  | ReviewBase & { type: 'mapping'; profile: { id: string; version: string }; pin: RevisionPin; proposal: SemanticMappingProposal; approved: number[] }
  | ReviewBase & { type: 'requirements'; proposal: SemanticRequirementProposal;
    spans: Array<SpanCheck['status']>; unsupportedSpans: Array<SpanCheck['status'] | null> };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const SPAN_STATUSES = new Set(['verified', 'mismatch', 'not-captured']);

function proposalOf<T>(value: unknown, parse: (answer: string) => T): T | null {
  try { return parse(JSON.stringify(value)); }
  catch (error) { console.warn('[Semantic reviews] Stored proposal failed validation', error); return null; }
}

export function decodeSemanticReview(value: unknown): SavedSemanticReview | null {
  if (!record(value) || value.version !== 1 || typeof value.id !== 'string' || !value.id || typeof value.createdAt !== 'string'
    || typeof value.origin !== 'string') return null;
  const base: ReviewBase = { version: 1, id: value.id, createdAt: value.createdAt, origin: value.origin };
  if (value.type === 'mapping') {
    const proposal = proposalOf(value.proposal, parseSemanticMapping);
    const pin = decodeRevisionPin(value.pin);
    if (!proposal || !pin || !record(value.profile) || typeof value.profile.id !== 'string' || typeof value.profile.version !== 'string'
      || !Array.isArray(value.approved) || !value.approved.length
      || !value.approved.every(index => Number.isInteger(index) && index >= 0 && index < proposal.mappings.length)
      || new Set(value.approved).size !== value.approved.length) return null;
    return { ...base, type: 'mapping', profile: { id: value.profile.id, version: value.profile.version }, pin, proposal, approved: [...value.approved] as number[] };
  }
  if (value.type === 'requirements') {
    const proposal = proposalOf(value.proposal, parseSemanticRequirements);
    if (!proposal || !Array.isArray(value.spans) || value.spans.length !== proposal.requirements.length
      || !value.spans.every(status => SPAN_STATUSES.has(String(status)))
      || !Array.isArray(value.unsupportedSpans) || value.unsupportedSpans.length !== proposal.unsupported.length
      || !value.unsupportedSpans.every(status => status === null || SPAN_STATUSES.has(String(status)))) return null;
    return { ...base, type: 'requirements', proposal, spans: [...value.spans] as Array<SpanCheck['status']>,
      unsupportedSpans: [...value.unsupportedSpans] as Array<SpanCheck['status'] | null> };
  }
  return null;
}

export const semanticReviewContent: ContentDefinition<SavedSemanticReview> = {
  kind: 'semanticReviews', legacyKey: 'ifc-lite-semantic-reviews-v1', decode: decodeSemanticReview,
};

export const useSemanticReviews = create<{ entries: SavedSemanticReview[]; status: ContentStatus }>(
  () => ({ entries: [], status: initialContentStatus() }));
export const semanticReviewLibrary = createContentLibrary(semanticReviewContent,
  () => useSemanticReviews.getState().entries,
  (entries, status) => useSemanticReviews.setState({ entries, status }));

export function saveSemanticReview(entry: SavedSemanticReview): Promise<boolean> {
  const decoded = decodeSemanticReview(JSON.parse(JSON.stringify(entry)));
  if (!decoded) return Promise.reject(new Error('The review cannot be saved: it failed validation'));
  return semanticReviewLibrary.put(decoded.id, decoded);
}
