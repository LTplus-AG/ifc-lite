/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `scheduleSlice`'s contribution to the store teardown registry (`store/teardown.ts`).
 *
 * SEPARATE FILE, not the bottom of `scheduleSlice.ts`, because that file sits
 * at its module-size budget exactly (1317 lines, frozen by
 * `scripts/module-size-allowlist.txt`): a single added line fails the ratchet,
 * and raising a budget to make room for a refactor is what the gate exists to
 * stop. Splitting at the teardown seam is the supported answer, and
 * `schedule-edit-helpers.ts` is the same slice's existing precedent for a
 * sibling module of this slice.
 *
 * Every value below is the slice's own initial value (`scheduleSlice.ts`
 * lines 378-385), which already matched what `resetViewerState` restated.
 */

import { defineSliceTeardown, notApplicable } from '../teardown.js';

/**
 * Schedule (4D) — drop panel + data; definitions are re-extracted on next load.
 *
 * `ganttTimeScale` is deliberately absent from both `owns` and the body: it is
 * a user preference that survives file loads, as are `playbackSpeed` and
 * `playbackLoop` over in `playbackSlice`.
 *
 * `clearGeneratedSchedule()` is called by `removeModel` when the federation
 * empties. That stays an entry-point side effect: it prunes generated tasks out
 * of a surviving `scheduleData` rather than dropping the whole extraction, so
 * it is not this teardown under another name.
 */
export const scheduleTeardown = defineSliceTeardown(
  'scheduleSlice',
  [
    'ganttPanelVisible',
    'generateScheduleDialogOpen',
    'scheduleData',
    'scheduleRange',
    'activeWorkScheduleId',
    'expandedTaskGlobalIds',
    'hoveredTaskGlobalId',
    'selectedTaskGlobalIds',
  ],
  {
    'session-reset': () => ({
      ganttPanelVisible: false,
      generateScheduleDialogOpen: false,
      scheduleData: null,
      scheduleRange: null,
      activeWorkScheduleId: '',
      expandedTaskGlobalIds: new Set<string>(),
      hoveredTaskGlobalId: null,
      selectedTaskGlobalIds: new Set<string>(),
    }),
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);
