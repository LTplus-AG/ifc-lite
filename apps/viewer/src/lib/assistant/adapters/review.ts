/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Review workspace's pinned coordination card as evidence (P18, #6922):
 * one row per finding in the card, native totals in the summary. The card is
 * pinned by the person asking (Ask about this card); with nothing pinned the
 * source is unavailable rather than silently empty. The pinned card lives
 * outside the viewer store, so `subscribe` lets an open picker follow it.
 */

import { useReviewAssistantCard } from '../../review/assistant-state';
import { unavailableCapture, type EvidenceAdapter } from './types';

export const reviewAdapter: EvidenceAdapter = {
  id: 'review', group: 'coordination', panelIds: ['review'],
  titleKey: 'reviewWorkspace.title', descriptionKey: 'assistantSources.review.description',
  rowMeaningKey: 'assistantSources.review.rows', unavailableKey: 'assistantSources.review.unavailable',
  suggestionKeys: ['assistantSources.review.suggestExplain', 'assistantSources.review.suggestNext'],
  subscribe: listener => useReviewAssistantCard.subscribe(listener),
  readiness: () => {
    const { card } = useReviewAssistantCard.getState();
    return card ? { status: { labelKey: 'assistantSources.review.ready', params: { count: card.findings.length } }, ready: true }
      : { status: { labelKey: 'assistantSources.review.none' }, ready: false };
  },
  identity: () => useReviewAssistantCard.getState().card,
  capture: (_state, limit) => {
    const { card, project } = useReviewAssistantCard.getState();
    return card && project ? project(limit) : unavailableCapture();
  },
};
