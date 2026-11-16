/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { captureReviewSnapshot } from '@/lib/review/collect';
import { currentReviewWorkspace, useReviewWorkspaces } from '@/lib/review/workspace';
import { filterCards, facetOptions } from '@/lib/review/facets';
import { coordination } from './coordination-common';
import { emptySchema } from './contract';
const selectedSchema = { type: 'object' as const, properties: {
  name: { type: 'string' as const, minLength: 1, maxLength: 200 },
  card_keys: { type: 'array' as const, minItems: 1, maxItems: 100, uniqueItems: true as const, items: { type: 'string' as const, minLength: 1, maxLength: 20000 } },
}, required: ['name', 'card_keys'] as ('name' | 'card_keys')[], additionalProperties: false as const };
function cards(keys: string[]) {
  const snapshot = captureReviewSnapshot(); const selected = snapshot.cards.filter(card => keys.includes(card.key));
  if (selected.length !== keys.length) throw new Error('Some review cards no longer exist; refresh the review snapshot.');
  return selected;
}
export const coordinationReviewOperations = [
  coordination('review.read', 'Collect native coordination findings, coverage gaps, cards and decisions.', ['read'], emptySchema, () => {
    const snapshot = captureReviewSnapshot(); const workspace = currentReviewWorkspace(useReviewWorkspaces.getState().entries);
    return { ...snapshot, workspace, facets: facetOptions(snapshot.cards, snapshot.runs, workspace) };
  }),
  coordination<{ finding_id: string }>('review.openOriginal', 'Resolve an exact current finding to its original native evidence and select its native row; refuses missing evidence or disabled destination panels.', ['view', 'selection', 'configuration'], {
    type: 'object', properties: { finding_id: { type: 'string', minLength: 1, maxLength: 20000 } }, required: ['finding_id'], additionalProperties: false,
  }, async (i, c) => {
    const [{ openOriginal, EVIDENCE_PANEL }, { isPanelAvailable }, { useViewerStore }] = await Promise.all([import('@/lib/review/open'), import('@/lib/panels/availability'), import('@/store')]);
    const finding = captureReviewSnapshot().cards.flatMap(card => card.findings).find(finding => finding.id === i.finding_id);
    if (!finding) throw new Error('Review finding is no longer present.');
    if (!isPanelAvailable(EVIDENCE_PANEL[finding.evidence.kind])) throw new Error('The native evidence panel is unavailable.');
    return c.commit(() => {
      const opened = openOriginal(finding, panel => { if (panel === 'properties') throw new Error('This finding has no workspace evidence panel.'); useViewerStore.getState().openWorkspacePanel(panel); });
      if (!opened) throw new Error('The original evidence changed or no longer exists.'); return { opened: true, finding_id: finding.id };
    });
  }),
  coordination<{ facet: 'source' | 'model' | 'state' | 'decision' | 'discipline' | 'storey' | 'run'; values: string[] }>('review.filter', 'Filter native review cards by an explicit source, model, state or decision facet.', ['read'], {
    type: 'object', properties: { facet: { type: 'string', enum: ['source', 'model', 'state', 'decision', 'discipline', 'storey', 'run'] },
      values: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 20000 } } }, required: ['facet', 'values'], additionalProperties: false,
  }, (i: { facet: 'source' | 'model' | 'state' | 'decision' | 'discipline' | 'storey' | 'run'; values: string[] }) => {
    const snapshot = captureReviewSnapshot(); const workspace = currentReviewWorkspace(useReviewWorkspaces.getState().entries);
    return { cards: filterCards(snapshot.cards, { [i.facet]: i.values }, workspace), totals: snapshot.totals, failed: snapshot.failed };
  }),
  coordination<{ name: string; card_keys: string[] }>('review.draftTopics', 'Create native BCF drafts from exact current card keys. Drafts retain their native publication review; this does not publish or mark a human decision.', ['configuration'], selectedSchema, async (i: { name: string; card_keys: string[] }, c) => {
    const { draftTopicsFromCards } = await import('@/lib/review/actions'); c.checkpoint?.(); return draftTopicsFromCards(i.name, cards(i.card_keys), write => c.commitAsync(write, result => result.saved));
  }),
  coordination<{ name: string; card_keys: string[] }>('review.createReport', 'Create a native document from exact current coordination cards and existing human decisions.', ['configuration'], selectedSchema, async (i: { name: string; card_keys: string[] }, c) => {
    const { addCardsToReport } = await import('@/lib/review/actions'); c.checkpoint?.(); return addCardsToReport(i.name, cards(i.card_keys), write => c.commitAsync(write, result => result.saved));
  }),
];
