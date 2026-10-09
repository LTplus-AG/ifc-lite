/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { StoreApi } from 'zustand';
import { effectiveMetadataRecord } from '@ifc-lite/parser';
import { liveEntityConforms } from '@ifc-lite/create';
import type { ViewerState } from '@/store';
import type { ModelChangeReceipt } from './model-change-commit';
import { costReviewDigest, type CostReview } from './cost-graph-review';

/** A non-root value or quantity has no IFC GlobalId. Preserve its real model-bound expressId instead. */
export function commitReviewedCost(store: StoreApi<ViewerState>, review: CostReview, origin: string): ModelChangeReceipt {
  const digest = costReviewDigest(review);
  const { rows, batchId } = review.commit();
  const modelId = review.proposal.modelId, state = store.getState();
  const dataStore = state.models.get(modelId)!.ifcDataStore!, view = state.mutationViews.get(modelId)!;
  return { version: 1, kind: 'cost.graph', id: crypto.randomUUID(), title: review.proposal.title, digest,
    createdAt: new Date().toISOString(), origin, status: 'applied', batches: [{ modelId, batchId }],
    applied: rows.map(row => {
      const expressId = row.expressId!;
      const after = effectiveMetadataRecord(dataStore, expressId, view);
      const prior = review.snapshot.records.find(record => record.expressId === expressId);
      const GlobalId = after && liveEntityConforms(dataStore, expressId, 'IfcRoot', view) ? after.attributes[0]
        : prior && /^Ifc(CostSchedule|CostItem)$/.test(prior.type) ? prior.attributes[0] : '';
      return { index: row.index, op: review.proposal.operations[row.index].op, expressId, modelId,
        globalId: typeof GlobalId === 'string' ? GlobalId : '', field: review.proposal.operations[row.index].op,
        before: prior ? JSON.stringify(prior) : null, after: after ? JSON.stringify({ expressId, ...after }) : null };
    }),
    skipped: review.proposal.operations.flatMap((_, index) => review.approved.has(index) ? [] : [{ index, status: 'not-approved' as const }]),
  };
}
