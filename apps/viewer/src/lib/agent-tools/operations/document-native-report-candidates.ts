/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import type { EvidenceSnapshot } from '@/lib/assistant/evidence';
import type { ReportRefreshPlan } from '@/lib/assistant/report-refresh';
import type { ReportDraft } from '@/lib/assistant/report-draft';
import type { DocumentSpec } from '@/lib/document/types';
import type { ViewerOperationContext } from './contract';
import { evictOldest } from './host-handles';
interface RefreshCandidate {
  kind: 'refresh'; documentId: string; plan: ReportRefreshPlan; evidence: EvidenceSnapshot;
  submitted?: { json: string; replace: string; document: DocumentSpec }; saving?: boolean;
}
/** staged: the JSON a refused save already wrote; it keeps the token and its identity, never blocks revision. */
interface DraftCandidate { kind: 'draft'; draft: ReportDraft; staged?: string; saving?: boolean }
export type NativeReportCandidate = RefreshCandidate | DraftCandidate;
const owners = new WeakMap<ViewerOperationContext['host'], Map<string, NativeReportCandidate>>();
function owned(host: ViewerOperationContext['host']) {
  let entries = owners.get(host); if (!entries) { entries = new Map(); owners.set(host, entries); } return entries;
}
export function addReportCandidate(host: ViewerOperationContext['host'], candidate: NativeReportCandidate) {
  const entries = owned(host); evictOldest(entries, 30, (entry) => entry.kind === 'draft' ? entry.staged === undefined && !entry.saving : !entry.submitted && !entry.saving); // a failed or in-flight save keeps its token
  if (entries.size >= 30) throw new Error('Too many native report candidates await a retry; apply or discard one first.');
  const token = crypto.randomUUID(); entries.set(token, candidate); return token;
}
export function reportCandidate(host: ViewerOperationContext['host'], token: string): NativeReportCandidate {
  const candidate = owned(host).get(token); if (!candidate) throw new Error('Unknown or discarded native report candidate for this host.'); return candidate;
}
export function discardReportCandidate(host: ViewerOperationContext['host'], token: string) { return owned(host).delete(token); }
/** A discard request from the caller: refused while a save is in flight, since that save can still persist. */
export function discardIdleReportCandidate(host: ViewerOperationContext['host'], token: string) {
  if (owned(host).get(token)?.saving) throw new Error('This native report candidate is being saved; discard it after the save finishes.');
  return discardReportCandidate(host, token);
}
export function nativeReportDocument(id: string): DocumentSpec {
  const document = useViewerStore.getState().documents.find(document => document.id === id);
  if (!document) throw new Error('Unknown native document. Initialize the native document library first.'); return document;
}
