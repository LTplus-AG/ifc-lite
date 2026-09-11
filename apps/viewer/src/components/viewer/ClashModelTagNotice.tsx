/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "The model tags this run was computed on have changed" (#4215).
 *
 * A clash run resolves tag-filtered sets from one snapshot and the engine then
 * runs for as long as the geometry takes; re-tagging a model meanwhile — or
 * after — leaves a result on screen that is right for the run and wrong for
 * the current tags. `lib/clash/model-tag-inputs.ts` records what the run used;
 * this says so next to the results, and only when a tag the run referenced
 * actually moved.
 */

import { AlertTriangle } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import { clashModelTagInputsChanged } from '@/lib/clash/model-tag-inputs';

export function ClashModelTagNotice() {
  const stale = useViewerStore(
    useShallow((s) => clashModelTagInputsChanged(s.clashResult, s.modelTagAssignments)),
  );
  if (!stale) return null;
  return (
    <div
      role="status"
      data-clash-tag-inputs-changed
      className="flex items-start gap-2 mx-3 mb-2 p-2 rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-400 text-xs"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
      <span>Model tags changed since this run. Its sets were resolved from the tags at the time; run again to use the current ones.</span>
    </div>
  );
}
