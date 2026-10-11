/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { StoreApi } from 'zustand';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { readGroupEvidenceInStore, type GroupNativeEvidence } from '@ifc-lite/create';
import { effectiveMetadataRecord } from '@ifc-lite/parser';
import { StoreEditor } from '@ifc-lite/mutations';
import type { ViewerState } from '@/store';
import { recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { mutationDenial } from '@/store/mutation-permission';
import { sameReportEvidence } from '@/lib/flow/report-provenance';
import { readOnlyModelEditLease } from './model-authoring-read-target';
import { parseGroupProposal, type GroupProposal } from './group-lifecycle-proposal';
import { writeGroupOperations, type GroupWriteRow } from './group-lifecycle-native';
import { batchDigest } from './model-change-preview';

export interface GroupDelta { expressId: number; before: { type: string; attributes: unknown[] } | null; after: { type: string; attributes: unknown[] } | null }
export interface GroupReview {
  proposal: GroupProposal; approved: ReadonlySet<number>; snapshot: GroupNativeEvidence; delta: GroupDelta[];
  validate(): void;
  commit(): { rows: GroupWriteRow[]; batchId: string };
}
/** Complete native graph, source content and overlay lease are verified again at the commit boundary. */
export function prepareGroupReview(store: StoreApi<ViewerState>, input: GroupProposal, approval?: ReadonlySet<number>): GroupReview {
  const proposal = parseGroupProposal(JSON.stringify(input)), signature = JSON.stringify(proposal);
  const initial = store.getState(), model = initial.models.get(proposal.modelId);
  const denial = mutationDenial(initial, proposal.modelId);
  if (denial) throw new Error(denial);
  const lease = readOnlyModelEditLease(initial, proposal.modelId);
  if (!lease || !model) throw new Error('The current loaded native Group source is unavailable');
  const capturedSources = [...initial.models].map(([id, row]) => ({ id, model: row, store: row.ifcDataStore, source: row.ifcDataStore?.source,
    hash: row.sourceContentHash, fingerprint: row.sourceFingerprint, view: initial.mutationViews.get(id), revision: initial.mutationViews.get(id)?.getMutationRevision() }));
  const read = (draft: StoreEditor) => readGroupEvidenceInStore({ store: lease.target.dataStore, mutationView: draft.getMutationView(), ownerHistoryId: null }, proposal.expected.selected);
  const snapshot = read(lease.target.editor);
  if (!sameReportEvidence(proposal.expected, snapshot)) throw new Error('The complete captured Group graph differs from the current native source; attach it again');
  const approved = new Set(approval ?? proposal.operations.map((_, index) => index));
  if (!approved.size || [...approved].some(index => !Number.isInteger(index) || index < 0 || index >= proposal.operations.length)) throw new Error('Approve at least one existing Group operation');
  const allocations = new Map<number, string[]>();
  const preview = lease.target.view.prepareAtomic(view => {
    const draft = new StoreEditor(lease.target.dataStore, view);
    const rows = writeGroupOperations(lease.target.dataStore, draft, proposal, snapshot, approved, index => () => {
      const guid = generateIfcGuid(), values = allocations.get(index) ?? [];
      values.push(guid); allocations.set(index, values); return guid;
    });
    const delta: GroupDelta[] = [];
    const ids = new Set(draft.getMutationView().getEffectiveChanges().map(change => change.entityId));
    for (const expressId of [...ids].sort((a, b) => a - b)) {
      const before = effectiveMetadataRecord(lease.target.dataStore, expressId, lease.target.view);
      const after = effectiveMetadataRecord(lease.target.dataStore, expressId, draft.getMutationView());
      const record = (row: typeof before) => row ? { type: row.type, attributes: structuredClone(row.attributes) as unknown[] } : null;
      if (!sameReportEvidence(record(before), record(after))) delta.push({ expressId, before: record(before), after: record(after) });
      if (delta.length > 200) throw new Error('Complete Group change population exceeds its review budget');
    }
    return { rows, delta };
  }).result;
  if (!preview.delta.length) throw new Error('The approved Group operations make no change');
  const evidenceSignature = JSON.stringify({ approved: [...approved], snapshot, delta: preview.delta, allocations: [...allocations] });
  const validate = (initializing = false) => {
    if (signature !== JSON.stringify(proposal) || evidenceSignature !== JSON.stringify({ approved: [...approved], snapshot, delta: preview.delta, allocations: [...allocations] })) throw new Error('The prepared Group review changed');
    const state = store.getState();
    if (state.models.size !== capturedSources.length || capturedSources.some(saved => {
      const current = state.models.get(saved.id);
      const initializingTarget = initializing && saved.id === proposal.modelId && saved.view === undefined;
      return current !== saved.model || current?.ifcDataStore !== saved.store || current?.ifcDataStore?.source !== saved.source || current?.sourceContentHash !== saved.hash
        || current?.sourceFingerprint !== saved.fingerprint || (!initializingTarget && (state.mutationViews.get(saved.id) !== saved.view || state.mutationViews.get(saved.id)?.getMutationRevision() !== saved.revision));
    })) throw new Error('The native Group source population changed');
    if (!initializing) lease.validate();
    const permission = mutationDenial(state, proposal.modelId);
    if (permission) throw new Error(permission);
  };
  let used = false;
  return { proposal, approved, snapshot, delta: preview.delta, validate: () => validate(), commit: () => {
    if (used) throw new Error('This Group review was already applied');
    validate(); const batchId = crypto.randomUUID();
    const rows = recordModellingEdit(store, proposal.modelId, (_methods, draft) => {
      validate(true);
      if (!sameReportEvidence(read(draft), snapshot)) throw new Error('The complete Group source differs at the native commit boundary');
      const cursors = new Map<number, number>();
      const written = writeGroupOperations(lease.target.dataStore, draft, proposal, snapshot, approved, index => () => {
        const cursor = cursors.get(index) ?? 0, guid = allocations.get(index)?.[cursor];
        if (!guid) throw new Error('Native Group allocation differs from the reviewed draft');
        cursors.set(index, cursor + 1); return guid;
      });
      if (!sameReportEvidence(written, preview.rows) || [...allocations].some(([index, values]) => values.length !== (cursors.get(index) ?? 0))) throw new Error('Native Group identities differ from the approved preview');
      return written;
    }, batchId);
    used = true; return { rows, batchId };
  } };
}
export function groupReviewDigest(review: GroupReview): string { return batchDigest({ proposal: review.proposal, approved: [...review.approved], snapshot: review.snapshot, delta: review.delta }); }
