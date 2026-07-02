/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clash tour: run detection, zoom to a clash, put it in context, and point
 * at the BCF handoff. The detection RESULT is the user's work product and is
 * never cleared; only the focus presentation (pair paint, contact overlay,
 * isolation/ghosting) is reset at the end - and even that is skipped when a
 * result already existed before the tour, so a mid-review session is never
 * wrenched away. Target: about 4 minutes.
 */

import { activityAnchor, TOUR_ANCHORS } from '../anchors';
import { loadDemoClashModel } from '../demo-kit';
import type { TourDefinition } from '../types';

/** Union values of `clashFocusMode` (clashSlice), encoded as indexes so the
 *  focus-mode step can baseline "changed since entry" with a number. */
const FOCUS_MODES = ['highlight', 'isolate', 'ghost'] as const;

/**
 * Whether a detection result already existed when the TOUR began (0/1).
 * Written by the first step's arm() - which always runs before any later
 * step - because per-step ctx cannot see tour-start state: by the time the
 * zoom step arms, the tour's own run step has already produced a result.
 * Single-tour-at-a-time is guaranteed by the controller.
 */
let hadClashResultAtTourStart = 0;

export const CLASH_TOUR: TourDefinition = {
  id: 'clash',
  title: 'Find clashes',
  description: 'Detect overlapping elements, zoom to a clash, and hand it off as a BCF issue.',
  minutes: 4,
  version: 1,
  panel: 'clash',
  prerequisites: { modelLoaded: true },
  // The base demo model has no interpenetrations; the interstitial loads
  // the rev-B variant, which carries one injected duct-vs-wall hard clash.
  demoFulfil: loadDemoClashModel,
  steps: [
    {
      id: 'open-panel',
      kind: 'action',
      anchor: activityAnchor('clash'),
      placement: 'left',
      title: 'Open clash detection',
      body: 'Open the Clash detection panel from the sidebar rail, or press Alt+6. It checks the model for elements that overlap.',
      arm: (state) => {
        hadClashResultAtTourStart = state.clashResult ? 1 : 0;
      },
      // No prepare: the user opens the panel themselves. Already open at
      // entry advances silently, which is fine.
      gate: { predicate: (s) => s.clashPanelVisible },
    },
    {
      id: 'run-detection',
      kind: 'action',
      anchor: TOUR_ANCHORS.clashRun,
      panel: 'clash',
      placement: 'left',
      title: 'Run a check',
      body: 'Click Detect all clashes. Hard clashes are real interpenetrations; touching contacts are ignored by default.',
      // A stale result must not satisfy the step: gate on the monotonic
      // completed-run counter instead of the result reference.
      arm: (state, ctx) => {
        ctx.baseline.clashRunSeq = state.clashRunSeq;
      },
      gate: {
        predicate: (s, ctx) => s.clashRunSeq > ctx.baseline.clashRunSeq && !s.clashRunning,
        // Large models legitimately take a while to check.
        hintAfterMs: 30_000,
      },
    },
    {
      id: 'read-summary',
      kind: 'passive',
      anchor: TOUR_ANCHORS.clashSummary,
      panel: 'clash',
      placement: 'left',
      title: 'Read the results',
      body: 'The summary counts every clash by severity. Severity comes from the element-type pair, not from how deep the overlap is.',
    },
    {
      id: 'zoom-to-clash',
      kind: 'action',
      anchor: TOUR_ANCHORS.clashResults,
      panel: 'clash',
      placement: 'left',
      title: 'Zoom to a clash',
      body: 'Click a result row. The camera flies to the pair, colors each element, and outlines the contact.',
      arm: (state, ctx) => {
        ctx.baseline.hadResultAtEntry = hadClashResultAtTourStart;
      },
      // Clear any focused clash so the gate is a genuine false -> true.
      // (Only sets clashSelectedId; the result itself is untouched.)
      prepare: (store) => {
        store.getState().setClashSelectedId(null);
      },
      gate: { predicate: (s) => s.clashSelectedId !== null },
      // Reset the focus PRESENTATION only - the store-level equivalent of
      // the panel's own Clear button (useClash.clearHighlight). Never the
      // result. Skipped entirely when a result pre-dated the tour: that
      // user was mid-review and keeps their view untouched.
      cleanup: (store, ctx) => {
        if (ctx.baseline.hadResultAtEntry === 1) return;
        const s = store.getState();
        s.clearEntitySelection();
        s.clearIsolation();
        s.clearGhost();
        s.setClashHighlightColors(null);
        s.setPendingColorUpdates(s.lensAppliedColors ?? new Map());
        s.setClashOverlapBox(null);
        s.setClashContactLines(null);
        s.setClashSelectedId(null);
      },
    },
    {
      id: 'focus-mode',
      kind: 'action',
      anchor: TOUR_ANCHORS.clashFocusMode,
      panel: 'clash',
      placement: 'left',
      title: 'See it in context',
      body: 'Switch On select to Ghost or Isolate. Ghost fades everything else to translucent context; Isolate hides it.',
      // Encode the entry mode as an index (numeric baseline); an unknown
      // value degrades to 0 rather than breaking the comparison.
      arm: (state, ctx) => {
        ctx.baseline.focusModeIdx = Math.max(0, FOCUS_MODES.indexOf(state.clashFocusMode));
      },
      gate: {
        predicate: (s, ctx) =>
          Math.max(0, FOCUS_MODES.indexOf(s.clashFocusMode)) !== ctx.baseline.focusModeIdx,
      },
    },
    {
      id: 'bcf-handoff',
      kind: 'passive',
      anchor: TOUR_ANCHORS.clashBcf,
      panel: 'clash',
      placement: 'left',
      title: 'Hand it off',
      body: 'BCF topic files the focused clash as an issue with a snapshot. Clear removes the highlights when you are done.',
    },
  ],
};
