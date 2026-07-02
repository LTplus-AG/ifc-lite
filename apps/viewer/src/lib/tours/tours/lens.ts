/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lens tour: apply the builtin By IFC Class lens (the instant multi-color
 * recolor is the aha), isolate one value from its legend, and bring the
 * model back. The applied lens is the payoff and survives finish via
 * keepOnFinish; abort restores the pre-tour lens through the snapshot
 * (activeLensId is a UiSnapshot field). The builtin lens needs no demo
 * fixture - BUILTIN_LENSES always ships lens-by-class. Target: about
 * 2 minutes.
 */

import { activityAnchor, lensCardAnchor, TOUR_ANCHORS } from '../anchors';
import type { TourDefinition } from '../types';

export const LENS_TOUR: TourDefinition = {
  id: 'lens',
  title: 'Color the model with lens rules',
  description: 'Apply a lens to recolor the model by rules, then isolate one value from its legend.',
  minutes: 2,
  version: 1,
  panel: 'lens',
  prerequisites: { modelLoaded: true },
  // The applied lens recolor is the payoff - keep it on finish. Abort still
  // restores the pre-tour lens via the engine snapshot.
  keepOnFinish: ['activeLensId'],
  steps: [
    {
      id: 'open-panel',
      kind: 'action',
      anchor: activityAnchor('lens'),
      placement: 'left',
      title: 'Open Lens rules',
      body: 'Open the Lens panel from the sidebar rail, or press Alt+5. Lenses recolor the model by rules.',
      gate: { predicate: (s) => s.lensPanelVisible },
    },
    {
      id: 'what-lenses',
      kind: 'passive',
      anchor: TOUR_ANCHORS.lensList,
      panel: 'lens',
      placement: 'left',
      title: 'Rules that color your view',
      body: 'A lens colors, fades, or hides elements that match rules: class, property, material, model, or zone. The built-in lenses are ready to use.',
    },
    {
      id: 'apply-lens',
      kind: 'action',
      anchor: lensCardAnchor('lens-by-class'),
      panel: 'lens',
      placement: 'left',
      title: 'Apply a lens',
      body: 'Click By IFC Class to activate it. The model recolors instantly, one color per IFC class.',
      // colorMap is written after evaluation, so this proves the visible
      // recolor, not just the click. Any lens counts - clicking Structural
      // instead still advances.
      gate: { predicate: (s) => s.activeLensId !== null && s.lensColorMap.size > 0 },
    },
    {
      id: 'isolate-legend',
      kind: 'action',
      anchor: TOUR_ANCHORS.lensLegend,
      panel: 'lens',
      placement: 'left',
      title: 'Isolate from the legend',
      body: 'Each legend row is one value with its color and match count. Click a row to show only those elements.',
      // Pre-existing (non-lens) isolation makes the gate true at entry; the
      // engine then advances silently, a harmless forward-skip. The baseline
      // only guards the cleanup: never clear an isolation the tour did not
      // create.
      arm: (state, ctx) => {
        ctx.baseline.hadIsolation = state.isolatedEntities !== null ? 1 : 0;
      },
      gate: { predicate: (s) => s.isolatedEntities !== null && s.isolatedEntities.size > 0 },
      // Normally step 5 (the user clearing it) makes this a no-op; it only
      // acts when tour-created isolation is still live at finish/abort.
      cleanup: (store, ctx) => {
        if (ctx.baseline.hadIsolation === 1) return;
        if (store.getState().isolatedEntities !== null) {
          store.getState().clearIsolation();
        }
      },
    },
    {
      id: 'bring-back',
      kind: 'action',
      anchor: TOUR_ANCHORS.lensLegend,
      panel: 'lens',
      placement: 'left',
      title: 'Bring everything back',
      body: 'Click the highlighted row again to clear the isolation. The lens stays active and the whole model returns.',
      gate: { predicate: (s) => s.isolatedEntities === null && s.activeLensId !== null },
    },
    {
      id: 'wrap',
      kind: 'passive',
      anchor: TOUR_ANCHORS.lensClear,
      panel: 'lens',
      placement: 'left',
      title: 'Your view, not your data',
      body: 'Lenses are view overlays and never modify the model. Clear restores original colors any time; New Rule Lens builds your own.',
    },
  ],
};
