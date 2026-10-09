/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { StoreApi } from 'zustand';
import { effectiveMetadataRecord } from '@ifc-lite/parser';
import { StoreEditor } from '@ifc-lite/mutations';
import type { ViewerState } from '@/store';
import { recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { mutationDenial } from '@/store/mutation-permission';
import { sameReportEvidence } from '@/lib/flow/report-provenance';
import { readOnlyModelEditLease } from './model-authoring-read-target';
import { readStructuralSnapshot, type StructuralNativeRecord, type StructuralSnapshot } from './structural-graph-evidence';
import { parseStructuralProposal, type StructuralProposal } from './structural-graph-proposal';
import { writeStructuralOperations, type StructuralWriteRow } from './structural-graph-native';
import { batchDigest } from './model-change-preview';

export interface StructuralDelta { expressId: number; before: StructuralNativeRecord | null; after: StructuralNativeRecord | null }
export interface StructuralReview {
  proposal: StructuralProposal;
  approved: ReadonlySet<number>;
  snapshot: StructuralSnapshot;
  delta: StructuralDelta[];
  validate(): void;
  commit(): { rows: StructuralWriteRow[]; delta: StructuralDelta[]; batchId: string };
}
function sources(state: Pick<ViewerState, 'models' | 'mutationViews'>) {
  return [...state.models].map(([id, model]) => ({ id, model, store: model.ifcDataStore, source: model.ifcDataStore?.source,
    hash: model.sourceContentHash, fingerprint: model.sourceFingerprint, view: state.mutationViews.get(id), revision: state.mutationViews.get(id)?.getMutationRevision() }));
}
/** Native dry-run and Apply share the same SDK graph factory; no engineering or load analysis is performed. */
export function prepareStructuralReview(store: StoreApi<ViewerState>, input: StructuralProposal, approval?: ReadonlySet<number>): StructuralReview {
  const proposal = parseStructuralProposal(JSON.stringify(input));
  const signature = JSON.stringify(proposal), state = store.getState();
  const denial = mutationDenial(state, proposal.modelId);
  if (denial) throw new Error(denial);
  const lease = readOnlyModelEditLease(state, proposal.modelId);
  if (!lease) throw new Error('The loaded native Structural model is unavailable');
  const expected = proposal.expected;
  if (!expected || typeof expected !== 'object' || !('selected' in expected) || !Array.isArray(expected.selected)
    || expected.selected.length > 100 || expected.selected.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)) throw new Error('Supply the complete native Structural snapshot with its explicit captured target population');
  const snapshot = readStructuralSnapshot(lease.target, expected.selected);
  if (!sameReportEvidence(expected, snapshot)) throw new Error('The supplied complete Structural graph differs from the current native source; attach it again');
  const approved = new Set(approval ?? proposal.operations.map((_, index) => index));
  if (!approved.size || [...approved].some(index => !Number.isInteger(index) || index < 0 || index >= proposal.operations.length)) throw new Error('Approve at least one existing Structural operation');
  const captured = sources(state);
  const preview = lease.target.view.prepareAtomic(view => {
    // Native StoreEditor belongs only to the detached lease; no allocator or live history is touched.
    const draft = new StoreEditor(lease.target.dataStore, view);
    {
      const rows = writeStructuralOperations(state, lease.target, draft, proposal, snapshot, approved);
      const after = readStructuralSnapshot({ ...lease.target, editor: draft, view: draft.getMutationView() }, snapshot.selected);
      const ids = new Set([...snapshot.records, ...after.records].map(row => row.expressId));
      for (const change of draft.getMutationView().getEffectiveChanges()) ids.add(change.entityId);
      if (ids.size > 400) throw new Error('The complete native Structural delta exceeds the review limit');
      const delta: StructuralDelta[] = [];
      for (const expressId of [...ids].sort((a, b) => a - b)) {
        const beforeRecord = effectiveMetadataRecord(lease.target.dataStore, expressId, lease.target.view);
        const afterRecord = effectiveMetadataRecord(lease.target.dataStore, expressId, draft.getMutationView());
        const native = (record: typeof beforeRecord): StructuralNativeRecord | null => record ? { expressId, type: record.type, attributes: structuredClone(record.attributes) as unknown[] } : null;
        const before = native(beforeRecord), next = native(afterRecord);
        if (!sameReportEvidence(before, next)) delta.push({ expressId, before, after: next });
      }
      return { rows, delta };
    }
  }).result;
  if (!preview.delta.length) throw new Error('The approved native operations make no change');
  // Fresh created GUIDs are native random identities, not a promised literal preview GUID.
  // Existing records, including every shared referrer/cascade target, are captured exactly.
  const reviewSignature = JSON.stringify({ snapshot, approved: [...approved], delta: preview.delta });
  const validate = (initializing = false) => {
    if (reviewSignature !== JSON.stringify({ snapshot, approved: [...approved], delta: preview.delta })) throw new Error('The reviewed Structural choices or native delta changed');
    if (signature !== JSON.stringify(proposal)) throw new Error('The reviewed Structural proposal changed');
    if (captured.length !== store.getState().models.size || captured.some(row => {
      const current = store.getState(), model = current.models.get(row.id);
      return model !== row.model || model?.ifcDataStore !== row.store || model?.ifcDataStore?.source !== row.source
        || model?.sourceContentHash !== row.hash || model?.sourceFingerprint !== row.fingerprint
        || (current.mutationViews.get(row.id) !== row.view || current.mutationViews.get(row.id)?.getMutationRevision() !== row.revision)
          && !(initializing && row.id === proposal.modelId && !row.view && !current.mutationViews.get(row.id)?.getEffectiveChanges().length);
    })) throw new Error('The loaded source or native Structural graph changed after review; prepare again');
    // Apply may initialize the canonical live editor's allocator watermark after the first held-lease check.
    // It is synchronous; source/revision and exact native snapshot are checked again before the first draft write.
    if (!initializing) lease.validate();
    const permission = mutationDenial(store.getState(), proposal.modelId);
    if (permission) throw new Error(permission);
  };
  let used = false;
  return { proposal, approved, snapshot, delta: preview.delta, validate: () => validate(), commit: () => {
    if (used) throw new Error('This Structural review has already been applied');
    validate();
    const batchId = crypto.randomUUID();
    const rows = recordModellingEdit(store, proposal.modelId, (_methods, draft) => {
      // Validate at the native transaction boundary before the first write.
      validate(true);
      const current = readStructuralSnapshot({ ...lease.target, editor: draft, view: draft.getMutationView() }, snapshot.selected);
      if (!sameReportEvidence(current, snapshot)) throw new Error('The complete Structural source differs at the native commit boundary');
      return writeStructuralOperations(store.getState(), lease.target, draft, proposal, snapshot, approved);
    }, batchId);
    used = true;
    return { rows, delta: preview.delta, batchId };
  } };
}
export function structuralReviewDigest(review: StructuralReview): string {
  return batchDigest({ proposal: review.proposal, approved: [...review.approved], snapshot: review.snapshot, delta: review.delta });
}
