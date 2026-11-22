/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { nativeDocumentRevision } from '@/lib/document/native-edit';
import { captureEvidence, evidenceIsCurrent } from '@/lib/assistant/evidence';
import { isAssistantSource } from '@/lib/assistant/sources';
import { applyReportRefresh, planReportRefresh, ReportRefreshError } from '@/lib/assistant/report-refresh';
import { viewerOperation } from './contract';
import { addReportCandidate, reportCandidate, discardReportCandidate, discardIdleReportCandidate, nativeReportDocument } from './document-native-report-candidates';
import { invalidInput, stale, unavailable } from './refusals';
const tokenInput = { type: 'object' as const, properties: { token: { type: 'string' as const, minLength: 1, maxLength: 200 } }, required: ['token' as const], additionalProperties: false as const };
const metadata = (id: string, description: string, properties: Record<string, unknown>) => ({ id, owner: 'document', description, effects: ['configuration'] as const, capability: 'commands-and-edits' as const, implementation: 'native-store' as const, outputSchema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } });
export const documentNativeReportOperations = [
  viewerOperation<{ document_id: string; expected_revision: string }>(metadata('document.prepareReportRefresh', 'Prepare the native deterministic saved AI-report refresh against recaptured current source evidence under the compact SHA-256 revision from document.inspect/library. Returns a host-owned token and exact per-human-block conflict choices; no network generation or document write occurs.', { token: { type: 'string' }, document_id: { type: 'string' }, claims: { type: 'array' }, conflicts: { type: 'array' }, models_changed: { type: 'boolean' } }), {
    type: 'object', properties: { document_id: { type: 'string', minLength: 1, maxLength: 200 }, expected_revision: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' } }, required: ['document_id', 'expected_revision'], additionalProperties: false,
  }, async (i, c) => {
    const document = nativeReportDocument(i.document_id); if (await nativeDocumentRevision(document) !== i.expected_revision || nativeReportDocument(i.document_id) !== document) throw stale('The native report document changed since inspection.');
    const source = document.aiReport?.evidence.source; if (!isAssistantSource(source)) throw invalidInput('wrong-target', 'This native document has no supported AI-report evidence source.');
    const evidence = captureEvidence(source);
    let plan: ReturnType<typeof planReportRefresh>;
    try { plan = planReportRefresh(document, evidence); }
    catch (error) {
      if (error instanceof ReportRefreshError) {
        if (error.key === 'aiReports.analysisStale') throw stale(error.message);
        if (error.key === 'aiReports.noNativeResult') throw unavailable(error.message);
      }
      throw error;
    }
    const token = c.commit(() => addReportCandidate(c.host, { kind: 'refresh', documentId: i.document_id, plan, evidence }));
    return { token, document_id: i.document_id, claims: structuredClone(plan.claims), conflicts: structuredClone(plan.conflicts), models_changed: plan.modelsChanged };
  }),
  viewerOperation<{ token: string; replace_block_ids: string[] }>(metadata('document.applyReportRefresh', 'Apply one exact prepared native refresh. Only listed human-block conflict IDs may be replaced; all other human edits and deletions retain the native refresh semantics. Rechecks source freshness and exact document at durable admission, returns native CAS persistence outcome, and preserves a failed-save candidate for exact retry.', { document_id: { type: 'string' }, saved: { type: 'boolean' }, storage: { type: 'object' }, revision: { type: 'string' } }), {
    type: 'object', properties: { token: tokenInput.properties.token, replace_block_ids: { type: 'array', maxItems: 10000, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 200 } } }, required: ['token', 'replace_block_ids'], additionalProperties: false,
  }, async (i, c) => {
    const candidate = reportCandidate(c.host, i.token); if (candidate.kind !== 'refresh') throw invalidInput('wrong-target', 'This token is not a native report refresh.');
    const replace = new Set(i.replace_block_ids); const conflicts = new Set(candidate.plan.conflicts.map(conflict => conflict.blockId)); if (i.replace_block_ids.some(id => !conflicts.has(id))) throw invalidInput('invalid-value', 'Only the exact prepared human-block conflict IDs may be replaced.');
    const choices = JSON.stringify([...replace].sort());
    return c.commitAsync(async () => {
      if (candidate.saving) throw unavailable('This native report refresh is already being saved.');
      if (!evidenceIsCurrent(candidate.evidence)) throw stale('Native report evidence changed; prepare the refresh again.');
      const current = nativeReportDocument(candidate.documentId), json = JSON.stringify(current);
      if (candidate.submitted) {
        if (json !== candidate.submitted.json || choices !== candidate.submitted.replace) throw stale('The native submitted document or replacement choices changed; prepare again.');
      } else {
        if (json !== candidate.plan.documentJson) throw stale('The native report document changed since refresh preparation.');
        const document = applyReportRefresh(current, candidate.plan, replace); candidate.submitted = { document, json: JSON.stringify(document), replace: choices };
      }
      c.checkpoint?.(); candidate.saving = true; let saved: boolean;
      try { saved = await useViewerStore.getState().upsertDocument(structuredClone(candidate.submitted.document)); } finally { candidate.saving = false; }
      if (saved) discardReportCandidate(c.host, i.token);
      return { document_id: candidate.documentId, saved, storage: useViewerStore.getState().documentsStorage, revision: await nativeDocumentRevision(candidate.submitted.document) };
    }, result => result.saved);
  }),
  viewerOperation<{ token: string }>(metadata('document.discardReportRefresh', 'Discard only this host-owned native refresh preview. Does not alter a document or discard any staged unsaved native persistence evidence.', { discarded: { type: 'boolean' } }), tokenInput, (i, c) => { const candidate = reportCandidate(c.host, i.token); if (candidate.kind !== 'refresh') throw invalidInput('wrong-target', 'This token is not a native report refresh.'); return c.commit(() => ({ discarded: discardIdleReportCandidate(c.host, i.token) })); }),
];
