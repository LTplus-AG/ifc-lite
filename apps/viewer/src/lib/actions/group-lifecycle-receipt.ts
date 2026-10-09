/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { StoreApi } from 'zustand';
import { effectiveMetadataRecord } from '@ifc-lite/parser';
import type { ViewerState } from '@/store';
import type { ModelChangeReceipt } from './model-change-commit';
import { groupReviewDigest, type GroupReview } from './group-lifecycle-review';

export function commitReviewedGroup(store: StoreApi<ViewerState>, review: GroupReview, origin: string): ModelChangeReceipt {
  const digest = groupReviewDigest(review), { rows, batchId } = review.commit();
  const modelId = review.proposal.modelId, state = store.getState();
  const dataStore = state.models.get(modelId)!.ifcDataStore!, view = state.mutationViews.get(modelId)!;
  return { version: 1, kind: 'group.lifecycle', id: crypto.randomUUID(), title: review.proposal.title, digest,
    createdAt: new Date().toISOString(), origin, status: 'applied', batches: [{ modelId, batchId }],
    applied: rows.map(row => {
      const after = effectiveMetadataRecord(dataStore, row.expressId, view);
      const before = review.snapshot.records.find(record => record.expressId === row.expressId);
      return { index: row.index, op: review.proposal.operations[row.index].op, expressId: row.expressId, modelId,
        globalId: row.GlobalId, field: review.proposal.operations[row.index].op,
        before: before ? JSON.stringify(before) : null, after: after ? JSON.stringify({ expressId: row.expressId, ...after }) : null };
    }),
    skipped: review.proposal.operations.flatMap((_, index) => review.approved.has(index) ? [] : [{ index, status: 'not-approved' as const }]),
  };
}
