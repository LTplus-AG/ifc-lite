/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { useAssistant } from '@/lib/assistant/conversation';
import { prepareReportDraft, reviseReportClaim, saveReportDraft, isReportDraftCurrent, contradictedClaims } from '@/lib/assistant/report-draft';
import { REPORT_LANGUAGES, type ReportLanguage } from '@/lib/assistant/report-language';
import { viewerOperation } from './contract';
import { addReportCandidate, reportCandidate, discardReportCandidate } from './document-native-report-candidates';
const string = { type: 'string' as const }, tokenProperty = { ...string, minLength: 1, maxLength: 200 }, documentProperty = { ...string, minLength: 2, maxLength: 2000000 };
const previewFields = { token: string, document_id: string, document_json: string, claims: { type: 'array' }, contradicted_claim_ids: { type: 'array', items: string }, historical: { type: 'boolean' }, language: string, declared_language: { type: ['string', 'null'] } };
const meta = (id: string, description: string, properties: Record<string, unknown>) => ({ id, owner: 'assistant', description, effects: ['configuration'] as const, capability: 'commands-and-edits' as const, implementation: 'native-store' as const, outputSchema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } });
function preview(token: string, draft: ReturnType<typeof prepareReportDraft>) { return { token, document_id: draft.document.id, document_json: draft.documentJson, claims: structuredClone(draft.claims), contradicted_claim_ids: contradictedClaims(draft).map(claim => claim.id), historical: draft.historical, language: draft.language, declared_language: draft.declaredLanguage }; }
export const documentNativeReportDraftOperations = [
  viewerOperation<{ name: string; language: ReportLanguage; expected_evidence_id: string; expected_answer: string }>(meta('assistant.prepareReportDraft', 'Prepare the actual native checked AI report from an exact completed native evidence conversation. Uses canonical fact/citation checking, generator block provenance and native language selection; returns a host-owned review token. No generic document import can substitute checked AI provenance.', previewFields), {
    type: 'object', properties: { name: { ...string, maxLength: 200 }, language: { type: 'string', enum: [...REPORT_LANGUAGES] }, expected_evidence_id: tokenProperty, expected_answer: { ...string, minLength: 1, maxLength: 200000 } }, required: ['name', 'language', 'expected_evidence_id', 'expected_answer'], additionalProperties: false,
  }, (i, c) => {
    const state = useAssistant.getState(); if ((state.snapshot?.id ?? state.archived?.id) !== i.expected_evidence_id || state.messages.at(-1)?.content !== i.expected_answer) throw new Error('The native evidence conversation or completed answer changed.');
    const draft = prepareReportDraft(i.name, i.language), token = c.commit(() => addReportCandidate(c.host, { kind: 'draft', draft })); return preview(token, draft);
  }),
  viewerOperation<{ token: string; expected_document_json: string; claim_id: string; action: 'edit' | 'remove'; text: string }>(meta('assistant.reviseReportDraftClaim', 'Edit or remove one exact native checked report claim through the canonical reviewer reducer. Rechecks the current native conversation and returns the recomposed checked document, including any remaining contradicted claims.', previewFields), {
    type: 'object', properties: { token: tokenProperty, expected_document_json: documentProperty, claim_id: tokenProperty, action: { type: 'string', enum: ['edit', 'remove'] }, text: { ...string, maxLength: 10000 } }, required: ['token', 'expected_document_json', 'claim_id', 'action', 'text'], additionalProperties: false,
  }, (i, c) => {
    const candidate = reportCandidate(c.host, i.token); if (candidate.kind !== 'draft' || candidate.draft.documentJson !== i.expected_document_json || !isReportDraftCurrent(candidate.draft)) throw new Error('This native report draft changed, was submitted or belongs to another workflow.');
    if (!candidate.draft.claims.some(claim => claim.id === i.claim_id)) throw new Error('Unknown checked native claim.');
    const draft = reviseReportClaim(candidate.draft, i.claim_id, i.action === 'remove' ? 'remove' : { text: i.text }); return c.commit(() => { candidate.draft = draft; return preview(i.token, draft); });
  }),
  viewerOperation<{ token: string; reviewed_document_json: string }>(meta('assistant.saveReportDraft', 'Save the exact reviewed checked native AI-report candidate through saveReportDraft, retaining canonical citation/fact/provenance validation, discussion freshness and native document CAS persistence. Contradicted claims must first be edited or removed. Does not overwrite another document and never treats provider completion as report approval.', { document_id: string, saved: { type: 'boolean' }, storage: { type: 'object' } }), {
    type: 'object', properties: { token: tokenProperty, reviewed_document_json: documentProperty }, required: ['token', 'reviewed_document_json'], additionalProperties: false,
  }, async (i, c) => {
    const candidate = reportCandidate(c.host, i.token); if (candidate.kind !== 'draft' || candidate.draft.documentJson !== i.reviewed_document_json) throw new Error('Unknown or changed native checked report draft.');
    c.checkpoint?.(); if (!await useViewerStore.getState().initializeDocuments()) throw new Error('Native document storage could not initialize.'); c.checkpoint?.();
    return c.commitAsync(async () => {
      if (!isReportDraftCurrent(candidate.draft)) throw new Error('The native report discussion or evidence changed.');
      const existing = useViewerStore.getState().documents.find(document => document.id === candidate.draft.document.id);
      // Only a document this candidate's own refused save staged may be overwritten.
      if (existing && (candidate.staged === undefined || JSON.stringify(existing) !== candidate.staged)) throw new Error('Another native document already owns this prepared report identity.');
      // A save in flight is never evicted; a refused save stays revisable and records what it staged.
      c.checkpoint?.(); candidate.saving = true;
      let saved: boolean;
      try { saved = await saveReportDraft(candidate.draft, i.reviewed_document_json); } finally { candidate.saving = false; }
      candidate.staged = candidate.draft.documentJson;
      if (saved) discardReportCandidate(c.host, i.token); return { document_id: candidate.draft.document.id, saved, storage: useViewerStore.getState().documentsStorage };
    }, result => result.saved);
  }),
  viewerOperation<{ token: string }>(meta('assistant.discardReportDraft', 'Discard this host-owned checked native report preview. Preserves any staged native document evidence from an earlier refused persistence attempt.', { discarded: { type: 'boolean' } }), {
    type: 'object', properties: { token: tokenProperty }, required: ['token'], additionalProperties: false,
  }, (i, c) => { const candidate = reportCandidate(c.host, i.token); if (candidate.kind !== 'draft') throw new Error('This token is not a native checked report draft.'); return c.commit(() => ({ discarded: discardReportCandidate(c.host, i.token) })); }),
];
