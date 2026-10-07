/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SavedSemanticReview, StoredSemanticReview } from './library';
import { parseSemanticMapping } from './mapping-proposal';
import { parseSemanticRequirements } from './requirement-proposal';

function proposalOf<T>(value: unknown, parse: (answer: string) => T): T | null {
  try { return parse(JSON.stringify(value)); }
  catch (error) { console.warn('[Semantic reviews] Stored proposal failed validation', error); return null; }
}

/** The strict decoders over a stored review: the proposal must parse and every decision must point at it. */
export function validateStoredReview(entry: StoredSemanticReview): SavedSemanticReview | null {
  if (entry.type === 'mapping') {
    const proposal = proposalOf(entry.proposal, parseSemanticMapping);
    return proposal && entry.approved.every(index => index < proposal.mappings.length) ? { ...entry, proposal } : null;
  }
  const proposal = proposalOf(entry.proposal, parseSemanticRequirements);
  return proposal && entry.spans.length === proposal.requirements.length && entry.unsupportedSpans.length === proposal.unsupported.length
    ? { ...entry, proposal } : null;
}
