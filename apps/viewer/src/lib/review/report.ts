/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Add to report": selected coordination cards as a new native document
 * (P18, #6922). Every value is literal text copied from the snapshot, so the
 * document stays readable after the source runs change; historical evidence
 * and resolution candidates are captioned as such, and the separately counted
 * totals travel with it. An existing human-authored document is never edited.
 */

import { literalTemplateText } from '../document/bindings';
import { freshBlockId, freshDocumentId } from '../document/persistence';
import { DOCUMENT_VERSION, validateDocumentSpec, type DocumentSpec, type TextBlock } from '../document/types';
import { cardTitle } from './bcf-draft';
import type { CoordinationCard, ReviewTotals } from './cards';
import { decisionFor, type ReviewWorkspace } from './workspace';

const STATE_TEXT: Record<CoordinationCard['state'], string> = {
  current: 'Observed in a current run',
  'not-evaluated': 'Historical evidence only; not re-evaluated by a complete current run',
  'resolution-candidate': 'No longer observed by a complete current run (resolution candidate, not a resolution)',
  record: 'Coordination record only',
};

export function reviewDocument(name: string, cards: readonly CoordinationCard[], totals: ReviewTotals,
  workspace: ReviewWorkspace, now = new Date()): DocumentSpec {
  const text = (style: TextBlock['style'], value: string): TextBlock => ({ kind: 'text', id: freshBlockId(), style, text: literalTemplateText(value) });
  const title = name.trim().slice(0, 200) || 'Coordination review';
  const blocks: TextBlock[] = [
    text('title', title),
    text('small', `Captured ${now.toISOString()} · ${cards.length} of ${totals.cards} card(s) included.\n`
      + `Review totals at capture (each counted separately): ${totals.uniqueElements} unique validated element(s), `
      + `${totals.currentFindings} current finding(s), ${totals.historicalFindings} historical finding(s), ${totals.cards} card(s), ${totals.topics} BCF topic(s).`),
  ];
  for (const card of cards) {
    const decision = decisionFor(workspace, card.key);
    blocks.push(text('heading', cardTitle(card)));
    blocks.push(text('small', [`State: ${STATE_TEXT[card.state]}.`,
      card.identity === 'unvalidated' ? 'Element identity not validated against the loaded models; shown on its own.' : '',
      `Elements: ${card.elements.map(element => `${element.globalId}${element.modelName ? ` (${element.modelName})` : ''}`).join(', ') || 'none named'}.`,
      decision ? `Reviewer decision: ${decision.status}${decision.comment ? ` — ${decision.comment}` : ''} (${decision.updatedAt}).` : 'Reviewer decision: none recorded.',
    ].filter(Boolean).join('\n')));
    blocks.push(text('body', card.findings.map(finding => `• [${finding.source}${finding.run.temporal === 'historical' ? ', historical' : ''}: ${finding.run.label}`
      + `${finding.run.complete ? '' : ', incomplete run'}] ${finding.title} — native status ${finding.nativeStatus || 'n/a'}`
      + (finding.detail.length ? `\n  ${finding.detail.slice(0, 3).join('\n  ')}` : '')).join('\n')));
  }
  const document: DocumentSpec = { version: DOCUMENT_VERSION, id: freshDocumentId(), name: title,
    page: { size: 'A4', orientation: 'portrait' }, blocks };
  const errors = validateDocumentSpec(document);
  if (errors.length) throw new Error(`Invalid native document: ${errors.map(error => error.message).join('; ')}`);
  return document;
}
