/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which undo batches a local agent made (#9523), so the Changes panel can say
 * so: batch id to the field the call changed (`Pset_WallCommon.FireRating`,
 * `Name`). Session state, like the undo history it labels: nothing is stored,
 * and a batch that leaves the history simply stops being listed. The oldest
 * labels drop off past {@link AGENT_CHANGE_LABEL_LIMIT}.
 *
 * The receipts the reviewed-change commit returns are not kept for this: they
 * are durable "reviewed changes" with their own list and Undo, and an agent
 * edit is not reviewed.
 */

import { create } from 'zustand';

export const AGENT_CHANGE_LABEL_LIMIT = 1000;

export const useAgentChangeLabels = create<{ byBatch: ReadonlyMap<string, string> }>(() => ({ byBatch: new Map() }));

/** Mark the undo batch `batchId` as the agent's edit of `field`. */
export function labelAgentChange(batchId: string, field: string): void {
  useAgentChangeLabels.setState((s) => {
    const byBatch = new Map(s.byBatch).set(batchId, field);
    for (const oldest of byBatch.keys()) {
      if (byBatch.size <= AGENT_CHANGE_LABEL_LIMIT) break;
      byBatch.delete(oldest);
    }
    return { byBatch };
  });
}

/** The field an agent changed in a Changes-panel operation (`batch:<id>`), if an agent made it. */
export function agentChangeLabelFor(byBatch: ReadonlyMap<string, string>, operationId: string): string | undefined {
  return operationId.startsWith('batch:') ? byBatch.get(operationId.slice('batch:'.length)) : undefined;
}
