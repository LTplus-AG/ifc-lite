/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { literalTemplateText } from '../document/bindings';
import { freshBlockId, freshDocumentId } from '../document/persistence';
import { DOCUMENT_VERSION, validateDocumentSpec, type DocumentSpec, type TextBlock } from '../document/types';
import { useAssistant } from './conversation';
import { evidenceIsCurrent } from './evidence';
import { decodeConversation, type SavedConversation } from './persistence';

export interface ReportDraft {
  source: SavedConversation;
  /** Pins the completed discussion; later turns cannot silently change a reviewed report. */
  conversationJson: string;
  document: DocumentSpec;
  documentJson: string;
  citations: string[];
  historical: boolean;
}

function completedConversation(): SavedConversation {
  const state = useAssistant.getState();
  const evidence = state.snapshot ?? state.archived?.evidence;
  if (!evidence || evidence.source === 'flow' || state.status !== 'idle' || state.error || state.output || state.pendingPrompt) {
    throw new Error('Choose a completed analysis answer before preparing a report.');
  }
  if (state.snapshot && !evidenceIsCurrent(state.snapshot)) throw new Error('Source evidence changed. Refresh before preparing a report.');
  const last = state.messages.at(-1);
  if (!last || last.role !== 'assistant') throw new Error('A report requires a completed assistant answer.');
  const entry = decodeConversation({ version: 1, id: state.snapshot?.id ?? state.archived?.id,
    name: state.archived?.name ?? 'Analysis discussion', savedAt: evidence.capturedAt, model: last.model,
    evidence, messages: state.messages });
  if (!entry) throw new Error('The discussion exceeds portable report limits.');
  return entry;
}

/** Citation existence is validated here; semantic support remains a visible human review duty. */
export function prepareReportDraft(name: string): ReportDraft {
  const source = completedConversation();
  const payload: unknown = JSON.parse(source.evidence.payload);
  if (!payload || typeof payload !== 'object' || !('evidence' in payload)) throw new Error('The report has no included evidence.');
  const facts = payload.evidence;
  if (!facts || typeof facts !== 'object' || !('rows' in facts) || !Array.isArray(facts.rows)) throw new Error('The report evidence rows are invalid.');
  const rows = facts.rows as unknown[];
  const ids = rows.map(row => {
    if (!row || typeof row !== 'object' || !('citation' in row) || typeof row.citation !== 'string'
      || !/^E[1-9]\d{0,2}$/.test(row.citation)) throw new Error('The report contains an invalid evidence identity.');
    return row.citation;
  });
  if (ids.length !== source.evidence.includedRows || new Set(ids).size !== ids.length) throw new Error('The report evidence coverage is inconsistent.');
  const answer = source.messages.at(-1)!;
  const citations = [...new Set([...answer.content.matchAll(/\bE\d+\b/g)].map(match => match[0]))];
  const unknown = citations.filter(id => !ids.includes(id));
  if (unknown.length) throw new Error(`Unknown evidence citations: ${unknown.join(', ')}`);
  const title = name.trim() || 'Analysis report draft';
  if (title.length > 200) throw new Error('Report names may contain at most 200 characters.');
  const text = (style: TextBlock['style'], value: string): TextBlock => ({ kind: 'text', id: freshBlockId(), style,
    text: literalTemplateText(value) });
  const document: DocumentSpec = { version: DOCUMENT_VERSION, id: freshDocumentId(), name: title,
    page: { size: 'A4', orientation: 'portrait' }, blocks: [
      text('title', title),
      text('small', `AI narrative draft · Source: ${source.evidence.source} · Captured: ${source.evidence.capturedAt}\nEvidence identity: ${source.id}\nProvider model: ${answer.model}`),
      text('body', `Included evidence: ${source.evidence.includedRows} of ${source.evidence.totalRows} native rows.\n`
        + (source.evidence.includedRows < source.evidence.totalRows ? 'This is a sample; unseen findings are not evaluated by this narrative.\n' : '')
        + (source.evidence.projectionTruncated ? 'Some evidence values were shortened or omitted.\n' : '')
        + 'Captured evidence is historical. AI prose requires human verification and does not change native results or certify compliance.'),
      text('heading', 'Narrative for review'), text('body', answer.content),
      text('small', citations.length ? `Referenced evidence: ${citations.join(', ')}. Citation existence does not prove that a claim is supported.`
        : 'The narrative has no row citations. Verify each factual claim against the captured evidence.'),
      { kind: 'page-break', id: freshBlockId() }, text('heading', 'Captured evidence appendix'),
      // All values and omitted-population notices travel with the native document, never live bindings.
      text('small', JSON.stringify(payload, null, 2)),
    ] };
  const errors = validateDocumentSpec(document);
  if (errors.length) throw new Error(`Invalid native document: ${errors.map(error => error.message).join('; ')}`);
  return { source, conversationJson: JSON.stringify(source), document, documentJson: JSON.stringify(document), citations,
    historical: useAssistant.getState().archived !== null };
}

export function isReportDraftCurrent(draft: ReportDraft): boolean {
  try {
    return draft.documentJson === JSON.stringify(draft.document) && draft.conversationJson === JSON.stringify(completedConversation());
  } catch (error) {
    // Expected refusal is exposed by the review UI; malformed data never becomes a save candidate.
    console.debug('[Assistant report] Review no longer current', error);
    return false;
  }
}

/** New native document, not an overwrite of an existing human-authored report. */
export async function saveReportDraft(draft: ReportDraft, reviewedJson: string): Promise<boolean> {
  if (reviewedJson !== draft.documentJson || !isReportDraftCurrent(draft)) throw new Error('The reviewed discussion or report changed. Prepare a new draft.');
  await useViewerStore.getState().initializeDocuments();
  if (!isReportDraftCurrent(draft)) throw new Error('The discussion changed while document storage initialized.');
  // Once submitted this is an explicitly historical artifact. Source changes while IDB commits
  // cannot retarget its embedded evidence or convert it into a live-result claim.
  return useViewerStore.getState().upsertDocument(structuredClone(draft.document));
}
