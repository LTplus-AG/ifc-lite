/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pending mutations of the FEDERATED composition only. Reads the UNDO
 * stacks, not the view's mutation history: the history is append-only
 * (undo applies inverse ops without removing the record), so publishing
 * from it would resurrect edits the user explicitly undid.
 *
 * Models outside the composition (a STEP model added alongside) have
 * their own overlapping expressId space — resolving those ids through
 * the composition's path bridge would publish onto unrelated entities,
 * so only models sharing the composed data store contribute. Georef
 * pseudo-mutations (entityId 0, georef.* attribute names) carry no
 * entity identity and are dropped.
 *
 * Shared by the Draft section (publish source) and the activity-bar
 * badge (draft-awareness signal).
 */

import type { Mutation } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';

export function pendingCompositionMutations(): Mutation[] {
  const state = useViewerStore.getState();
  const out: Mutation[] = [];
  for (const [modelId, model] of state.models) {
    if (model.ifcDataStore !== state.ifcDataStore) continue;
    for (const mutation of state.undoStacks.get(modelId) ?? []) {
      if (mutation.attributeName?.startsWith('georef.')) continue;
      out.push(mutation);
    }
  }
  return out;
}
