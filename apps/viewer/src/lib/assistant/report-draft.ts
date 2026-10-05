/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { freshDocumentId } from '../document/persistence';
import type { AiReportRecord } from '../document/ai-report-types';
import { DOCUMENT_VERSION, validateDocumentSpec, type DocumentSpec, type TableBlock } from '../document/types';
import { useAssistant } from './conversation';
import { evidenceIsCurrent } from './evidence';
import { decodeConversation, type SavedConversation } from './persistence';
import { buildReportBlocks } from './report-blocks';
import { checkProposedClaims, editClaim, splitReportAnswer, type CheckedClaim } from './report-claims';
import { parseCapturedEvidence, type CapturedEvidence } from './captured-rows';
import { rowIdentity, SUMMARY_CITATION } from './report-facts';
import type { ReportLanguage } from './report-language';
import { nativeTableBlocks } from './report-sources';
import { isReportSource } from './sources';

export interface ReportDraft {
  source: SavedConversation;
  /** Pins the completed discussion; later turns cannot silently change a reviewed report. */
  conversationJson: string;
  /** Narrative language chosen for this draft, independent of the UI language. */
  language: ReportLanguage;
  /** Language the provider declared in its typed claims, when it declared one. */
  declaredLanguage: string | null;
  prose: string;
  claims: CheckedClaim[];
  captured: CapturedEvidence;
  tables: TableBlock[];
  document: DocumentSpec;
  documentJson: string;
  /** Citations used by the prose narrative. */
  citations: string[];
  historical: boolean;
}

function completedConversation(): SavedConversation {
  const state = useAssistant.getState();
  const evidence = state.snapshot ?? state.archived?.evidence;
  if (!evidence || !isReportSource(evidence.source) || state.status !== 'idle' || state.error || state.output || state.pendingPrompt) {
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

/** Row identity of every row the claims or the narrative cite, so a refresh can find the same native row again. */
function citedRows(claims: CheckedClaim[], prose: string[], captured: CapturedEvidence): Record<string, string | null> {
  const cited: Record<string, string | null> = {};
  for (const citation of [...prose, ...claims.flatMap(claim => claim.citations)]) {
    if (citation === SUMMARY_CITATION) cited[citation] = SUMMARY_CITATION;
    else cited[citation] = captured.rows.has(citation) ? rowIdentity(captured.rows.get(citation)) : null;
  }
  return cited;
}

function compose(draft: Omit<ReportDraft, 'document' | 'documentJson'>, id: string, title: string): DocumentSpec {
  const answer = draft.source.messages.at(-1)!;
  const record: AiReportRecord = { version: 1, language: draft.language, model: answer.model ?? 'unknown', conversationId: draft.source.id,
    revision: 1, evidence: { ...draft.source.evidence }, citedRows: citedRows(draft.claims, draft.citations, draft.captured),
    claims: draft.claims.map(({ id: claimId, text, citations, facts, status, edited }) => ({ id: claimId, text, citations, facts, status, edited })),
    narrative: draft.prose, slots: [] };
  const blocks = buildReportBlocks({ title, record, tables: draft.tables, proseCitations: draft.citations,
    claims: draft.claims.map(claim => ({ claim, current: citation => citation })) });
  record.slots = blocks.flatMap(entry => entry.slot ? [entry.slot] : []);
  const document: DocumentSpec = { version: DOCUMENT_VERSION, id, name: title, page: { size: 'A4', orientation: 'portrait' },
    blocks: blocks.map(entry => entry.block), aiReport: record };
  const errors = validateDocumentSpec(document);
  if (errors.length) throw new Error(`Invalid native document: ${errors.map(error => `${error.path} ${error.message}`).join('; ')}`);
  return document;
}

/** Claims are checked against the captured rows; prose citations must exist. Semantic support stays a human review duty. */
export function prepareReportDraft(name: string, language: ReportLanguage = 'en'): ReportDraft {
  const source = completedConversation();
  const captured = parseCapturedEvidence(source.evidence.payload);
  if (captured.rows.size !== source.evidence.includedRows) throw new Error('The report evidence coverage is inconsistent.');
  const answer = source.messages.at(-1)!;
  const { prose, envelope } = splitReportAnswer(answer.content);
  const citations = [...new Set([...prose.matchAll(/\bE\d+\b/g)].map(match => match[0]))];
  const unknown = citations.filter(id => !captured.rows.has(id));
  if (unknown.length) throw new Error(`Unknown evidence citations: ${unknown.join(', ')}`);
  const title = name.trim() || 'Analysis report draft';
  if (title.length > 200) throw new Error('Report names may contain at most 200 characters.');
  const historical = useAssistant.getState().archived !== null;
  const parts = { source, conversationJson: JSON.stringify(source), language, declaredLanguage: envelope?.language ?? null, prose,
    claims: envelope ? checkProposedClaims(envelope.claims, captured) : [], captured, citations, historical,
    // Native tables describe the live source, so only a current capture may add them.
    tables: historical ? [] : nativeTableBlocks(source.evidence.source, { title }) };
  const document = compose(parts, freshDocumentId(), title);
  return { ...parts, document, documentJson: JSON.stringify(document) };
}

/** Reviewer edit or removal of one claim; the document is recomposed under the same identity. */
export function reviseReportClaim(draft: ReportDraft, claimId: string, edit: { text: string } | 'remove'): ReportDraft {
  const claims = edit === 'remove' ? draft.claims.filter(claim => claim.id !== claimId)
    : draft.claims.map(claim => claim.id === claimId ? editClaim(claim, edit.text, draft.captured) : claim);
  const parts = { ...draft, claims };
  const document = compose(parts, draft.document.id, draft.document.name);
  return { ...parts, document, documentJson: JSON.stringify(document) };
}

/** Claims that must be edited or removed before the report can be saved. */
export function contradictedClaims(draft: ReportDraft): CheckedClaim[] {
  return draft.claims.filter(claim => claim.status === 'contradicted');
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
  const blocked = contradictedClaims(draft);
  if (blocked.length) throw new Error(`Claims contradicted by the captured evidence must be edited or removed: ${blocked.map(claim => claim.id).join(', ')}`);
  await useViewerStore.getState().initializeDocuments();
  if (!isReportDraftCurrent(draft)) throw new Error('The discussion changed while document storage initialized.');
  // Once submitted this is an explicitly historical artifact. Source changes while IDB commits
  // cannot retarget its embedded evidence or convert it into a live-result claim.
  return useViewerStore.getState().upsertDocument(structuredClone(draft.document));
}
