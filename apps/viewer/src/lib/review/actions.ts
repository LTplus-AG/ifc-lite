/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Review workspace's two actions (P18, #6922): draft BCF topics and add
 * to report. Both create *new* native content (a draft batch, a document);
 * neither edits a BCF topic, a clash status or an existing document.
 */

import { useViewerStore } from '@/store';
import { bcfWorldOffset } from '@/hooks/bcf/viewpoint-world-frame';
import { saveDraftBatch, useBcfDraftLibrary } from '../bcf-drafts/draft-library';
import { DRAFT_LIMITS, type DraftBatch } from '../bcf-drafts/draft-types';
import { totalsForCards, type CoordinationCard } from './cards';
import { draftBatchFromCards, type CardDraftResult } from './bcf-draft';
import { reviewDocument } from './report';
import { currentReviewWorkspace, useReviewWorkspaces } from './workspace';

export interface SavedCardDrafts extends CardDraftResult {
  saved: boolean;
  /**
   * The durable draft codec refused the batch, so retrying cannot save it: `topic-too-many` when one topic
   * (one card) holds more findings than a topic allows, which drafting fewer cards cannot fix; `too-many` when
   * the batch holds more topics than a draft allows; else `field-limit` (a value beyond its limit).
   */
  invalid?: 'topic-too-many' | 'too-many' | 'field-limit';
}

function refusal(batch: DraftBatch): NonNullable<SavedCardDrafts['invalid']> {
  if (batch.topics.some(topic => topic.members.length > DRAFT_LIMITS.members
    || (topic.sourceFindings?.length ?? 0) > DRAFT_LIMITS.members)) return 'topic-too-many';
  return batch.topics.length > DRAFT_LIMITS.topics ? 'too-many' : 'field-limit';
}

/** The translated note for a draft result: a refusal names its reason instead of suggesting a retry. */
export function cardDraftNoteKey(result: SavedCardDrafts) {
  if (!result.batch) return 'reviewWorkspace.actions.draftNone' as const;
  if (result.saved) return 'reviewWorkspace.actions.draftSaved' as const;
  if (result.invalid === 'topic-too-many') return 'reviewWorkspace.actions.draftTopicTooMany' as const;
  if (result.invalid === 'too-many') return 'reviewWorkspace.actions.draftTooMany' as const;
  if (result.invalid === 'field-limit') return 'reviewWorkspace.actions.draftFieldLimit' as const;
  return 'reviewWorkspace.actions.draftUnsaved' as const;
}

/** One topic per eligible card, saved as a draft batch the BCF drafts dialog then reviews. */
export async function draftTopicsFromCards(name: string, cards: readonly CoordinationCard[]): Promise<SavedCardDrafts> {
  const state = useViewerStore.getState();
  const result = await draftBatchFromCards(name, cards, state.clashResult?.clashes ?? [],
    { worldOffset: bcfWorldOffset(state.models, state.geometryResult) });
  if (!result.batch) return { ...result, saved: false };
  const saved = await saveDraftBatch(result.batch);
  if (saved) useBcfDraftLibrary.setState({ activeId: result.batch.id });
  const invalid = !saved && useBcfDraftLibrary.getState().status.items[result.batch.id] === 'invalid';
  return { ...result, saved, ...(invalid ? { invalid: refusal(result.batch) } : {}) };
}

/** A new native document of the selected cards; never overwrites an existing document. */
export async function addCardsToReport(name: string, cards: readonly CoordinationCard[]): Promise<{ id: string; saved: boolean }> {
  const state = useViewerStore.getState();
  await state.initializeDocuments();
  const document = reviewDocument(name, cards, totalsForCards(cards), currentReviewWorkspace(useReviewWorkspaces.getState().entries));
  return { id: document.id, saved: await useViewerStore.getState().upsertDocument(document) };
}
