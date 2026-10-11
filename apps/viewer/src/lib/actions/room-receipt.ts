/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { batchDigest } from './model-change-preview';
import type { ModelChangeReceipt } from './model-change-commit';
import type { RoomReview } from './room-review';

/** Receipt references the actual native group; it never owns a plate or invents an Undo token. */
export function commitReviewedRoom(review: RoomReview, origin: string) {
  const modelId = review.proposal.modelId;
  const old = new Set((useViewerStore.getState().undoStacks.get(modelId) ?? []).map(row => row.id));
  const result = review.commit();
  const state = useViewerStore.getState();
  const tags = new Set((state.undoStacks.get(modelId) ?? []).filter(row => !old.has(row.id))
    .flatMap(row => { const tag = state.mutationBatchTags.get(row.id); return tag ? [tag] : []; }));
  const receipt: ModelChangeReceipt = { version: 1, kind: 'room.command', id: crypto.randomUUID(),
    title: review.proposal.title, digest: batchDigest({ proposal: review.proposal, snapshot: review.snapshot }),
    createdAt: new Date().toISOString(), origin, status: 'applied',
    batches: [...tags].map(batchId => ({ modelId, batchId })),
    applied: [{ index: 0, op: 'room.command', globalId: review.snapshot.storey.GlobalId, modelId,
      field: `Room ${review.proposal.command.action}`, before: JSON.stringify({ rooms: review.snapshot.roomCount, candidates: review.snapshot.candidateCount }),
      after: JSON.stringify({ created: result.created.length, updated: result.updated.length, deleted: result.deleted.length,
        skipped: result.skipped.length, sessionOnly: !!review.prepared.layoutAfter && result.created.length + result.updated.length + result.deleted.length === 0 }) }],
    skipped: result.skipped.map((_, index) => ({ index, status: 'blocked' })),
  };
  return { result, receipt };
}
