/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';

/**
 * The undo STEPS on a model's stack, which is what Ctrl+Z walks: the
 * mutations one commit tagged with a batch id count once, an untagged entry
 * counts alone. A commit may write several mutations (a wall and its recorded
 * top, #9013), so "one undo step" is asserted here, not on the raw length.
 */
export function undoSteps(modelId: string): number {
  const s = useViewerStore.getState();
  let steps = 0;
  let previous: string | undefined;
  for (const mutation of s.undoStacks.get(modelId) ?? []) {
    const tag = s.mutationBatchTags.get(mutation.id);
    if (tag === undefined || tag !== previous) steps++;
    previous = tag;
  }
  return steps;
}
