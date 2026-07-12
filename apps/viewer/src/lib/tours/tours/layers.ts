/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Layers tour (#1717): the "Git for buildings" walkthrough. A composed
 * IFC5 model is a stack of immutable layers - the tour reads the strata,
 * isolates one layer's contribution in 3D, opens its provenance, and
 * points at the draft-publish and merge/review loops. The prerequisite
 * interstitial loads the bundled demo stack (hello-wall base + an
 * agent-published fire-safety pass + a human review bump), so the tour
 * runs anywhere with one click and no files. Diff/ghost state is the
 * outcome, not tour-owned - closing the diff clears the ghost, so there
 * is nothing to tear down. Target: about 4 minutes.
 */

import { activityAnchor, TOUR_ANCHORS } from '../anchors';
import { loadDemoLayerStack } from '@/lib/layers/demo-stack';
import { getViewerStoreApi } from '@/store';
import type { TourDefinition } from '../types';

/** Dispatching the load event is fire-and-forget; the interstitial needs
 *  the COMPOSED stack before the first gated step can ever pass. */
async function loadDemoStackAndSettle(timeoutMs = 120_000): Promise<void> {
  await loadDemoLayerStack();
  const store = getViewerStoreApi();
  const start = Date.now();
  await new Promise<void>((resolve, reject) => {
    const check = () => {
      const s = store.getState();
      if (s.layerStack.length >= 2 && !s.loading) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('demo layer stack did not settle in time'));
        return;
      }
      setTimeout(check, 200);
    };
    check();
  });
}

export const LAYERS_TOUR: TourDefinition = {
  id: 'layers',
  title: 'Layers: version a model like code',
  description:
    "Read a composed layer stack, isolate one layer's changes in 3D, check its provenance, and see how edits publish and merge.",
  minutes: 4,
  version: 1,
  panel: 'layers',
  prerequisites: { layerStack: true },
  demoFulfil: loadDemoStackAndSettle,
  steps: [
    {
      id: 'open-panel',
      kind: 'action',
      anchor: activityAnchor('layers'),
      placement: 'left',
      title: 'Open Layers',
      body: 'Open the Layers panel from the sidebar rail. It shows the composition behind the model: immutable layers, strongest opinion on top.',
      // Same panel-open truth as the compare tour: docked counts only while
      // the sidebar is expanded; floating/popped count regardless.
      gate: {
        predicate: (s) =>
          (s.sidebarMode === 'expanded' &&
            (s.sidebarActivePanel === 'layers' || s.sidebarSecondaryPanel === 'layers')) ||
          s.floatingPanels.some((p) => p.id === 'layers') ||
          s.poppedOutIds.includes('layers'),
      },
    },
    {
      id: 'read-strata',
      kind: 'passive',
      anchor: TOUR_ANCHORS.layersStrata,
      panel: 'layers',
      placement: 'left',
      title: 'Every change is a layer',
      body: 'Each stratum is a content-addressed, immutable layer. The badges show WHO wrote it - human, agent, or a merge - plus its checks and blake3 id. The demo stack has an agent-published fire-safety pass overridden by a human review.',
    },
    {
      id: 'inspect-diff',
      kind: 'action',
      anchor: TOUR_ANCHORS.layersStrata,
      panel: 'layers',
      placement: 'left',
      title: 'What did one layer change?',
      body: 'Click "Changes" on a stratum. The contribution diff lists exactly what that layer added, modified, or deleted - clicking a row selects the entity in 3D.',
      gate: { predicate: (s) => s.layerStackDiff !== null },
    },
    {
      id: 'ghost-others',
      kind: 'action',
      anchor: TOUR_ANCHORS.layersDiff,
      panel: 'layers',
      placement: 'left',
      title: 'Isolate it in 3D',
      body: 'Toggle "Ghost others": everything the layer did NOT touch fades, so its footprint is unmissable - even in a large model.',
      gate: { predicate: (s) => s.ghostExceptEntities !== null && s.ghostExceptEntities.size > 0 },
    },
    {
      id: 'provenance',
      kind: 'passive',
      anchor: TOUR_ANCHORS.layersStrata,
      panel: 'layers',
      placement: 'left',
      title: 'Provenance, not vibes',
      body: 'Expand a stratum for the full manifest: author and tool, intent, declared scope, IDS check evidence (fetchable from a registry), signatures, and - on merge layers - who resolved what.',
    },
    {
      id: 'draft',
      kind: 'passive',
      anchor: TOUR_ANCHORS.layersDraft,
      panel: 'layers',
      placement: 'left',
      title: 'Your edits become layers',
      body: "Edit any property in the model and it collects here as a pending draft. Publishing freezes it into a new immutable layer on a local ref - in a live collab session, the whole session's edits can publish together.",
    },
    {
      id: 'merge',
      kind: 'passive',
      anchor: TOUR_ANCHORS.layersMerge,
      panel: 'layers',
      placement: 'left',
      title: 'Merge with reviews and checks',
      body: 'Pick a candidate and a target ref, preview the three-way plan, and work the conflict queue - ours, theirs, or edit-in-place. Registry refs enforce required checks, approvals, and BCF review comments server-side. Model versions, with pull requests.',
    },
  ],
};
