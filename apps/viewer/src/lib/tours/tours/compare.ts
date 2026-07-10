/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compare tour: diff two loaded revisions, read the recolored 3D result, and
 * drill into one changed element. Needs TWO fully loaded models - the
 * prerequisite interstitial loads demo base + revision B (a REPLACE) when the
 * user has fewer. The comparison result and its recolor are the outcome and
 * are not tour-owned state, so there is nothing to clean up. Target: about
 * 4 minutes.
 */

import { activityAnchor, TOUR_ANCHORS } from '../anchors';
import { DEMO_MODEL_NAMES, loadDemoRevisions } from '../demo-kit';
import type { TourDefinition } from '../types';

export const COMPARE_TOUR: TourDefinition = {
  id: 'compare',
  title: 'Compare two revisions',
  description: 'Diff two revisions of a model: added, deleted, and changed elements, recolored in 3D.',
  minutes: 4,
  version: 1,
  panel: 'compare',
  prerequisites: { modelLoaded: true, secondModel: true },
  demoFulfil: loadDemoRevisions,
  steps: [
    {
      id: 'open-panel',
      kind: 'action',
      anchor: activityAnchor('compare'),
      placement: 'left',
      title: 'Open Compare',
      body: 'Open the Compare panel from the sidebar rail, or press Alt+2. It diffs two loaded revisions of the same model.',
      // Panel-open truth is the sidebar/dock state, NOT the legacy
      // comparePanelVisible field. Docked counts only while the sidebar is
      // expanded; a floating or popped-out panel counts regardless
      // (mirrors usePanelControls.isOpen).
      gate: {
        predicate: (s) =>
          (s.sidebarMode === 'expanded' &&
            (s.sidebarActivePanel === 'compare' || s.sidebarSecondaryPanel === 'compare')) ||
          s.floatingPanels.some((p) => p.id === 'compare') ||
          s.poppedOutIds.includes('compare'),
      },
    },
    {
      id: 'ab-picks',
      kind: 'passive',
      anchor: TOUR_ANCHORS.compareAb,
      panel: 'compare',
      placement: 'left',
      title: 'A is old, B is new',
      body: 'A is the base revision, B is the newer one. Swap them here if they are backwards.',
    },
    {
      id: 'run',
      kind: 'action',
      anchor: TOUR_ANCHORS.compareRun,
      panel: 'compare',
      placement: 'left',
      title: 'Run the comparison',
      body: 'Click Run comparison. Elements are matched by their IFC GlobalId and checked for data and geometry changes.',
      // With the demo pair loaded, pin A/B the right way round (base = A,
      // rev B = B) so the diff direction matches the copy. A user's own
      // 2+ models keep the panel's auto-default untouched.
      prepare: (store) => {
        const s = store.getState();
        const models = [...s.models.values()];
        // Exact kit names only - anything else keeps the panel's defaults.
        const base = models.find((m) => m.name === DEMO_MODEL_NAMES.base);
        const revB = models.find((m) => m.name === DEMO_MODEL_NAMES.revB);
        if (!base || !revB) return;
        s.setCompareBaseModelId(base.id);
        s.setCompareHeadModelId(revB.id);
      },
      // A stale result must not satisfy the step: gate on the monotonic
      // completed-comparison counter, not the result reference.
      arm: (state, ctx) => {
        ctx.baseline.compareRunSeq = state.compareRunSeq;
      },
      gate: {
        predicate: (s, ctx) => s.compareRunSeq > ctx.baseline.compareRunSeq && !s.compareRunning,
        // Fingerprinting two large models legitimately takes a while.
        hintAfterMs: 30_000,
      },
    },
    {
      id: 'read-counts',
      kind: 'passive',
      anchor: TOUR_ANCHORS.compareCounts,
      panel: 'compare',
      placement: 'left',
      title: 'Read the results',
      body: 'The 3D view is recolored: green added, red deleted, orange changed, unchanged ghosted. Moves land under Changed as geometry changes.',
    },
    {
      id: 'focus-change',
      kind: 'action',
      anchor: TOUR_ANCHORS.compareResults,
      panel: 'compare',
      placement: 'left',
      title: 'Focus a change',
      body: 'Pick a row under Changed to see field-level before/after values. The viewer selects and frames the element in 3D.',
      // runComparison resets compareSelectedKey to null, so after the run
      // step this is a genuine false -> true transition; no baseline needed.
      gate: { predicate: (s) => s.compareSelectedKey !== null },
    },
    {
      id: 'detail',
      kind: 'passive',
      anchor: TOUR_ANCHORS.compareDetail,
      panel: 'compare',
      placement: 'left',
      title: 'See exactly what changed',
      body: 'The detail lists before and after values; a moved element shows its Moved distance. Export a report or raise a BCF issue from here.',
    },
  ],
};
