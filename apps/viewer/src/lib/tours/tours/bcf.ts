/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF tour: select a problem, raise a topic with an auto-attached snapshot,
 * capture a second viewpoint, and export the .bcfzip. Topics and viewpoints
 * are the user's data - deliberately NO cleanup anywhere in this tour.
 * Target: about 3 minutes.
 */

import { activityAnchor, TOUR_ANCHORS } from '../anchors';
import { EVENT_FILE_DOWNLOADED } from '../events';
import type { TourDefinition } from '../types';

export const BCF_TOUR: TourDefinition = {
  id: 'bcf',
  title: 'Raise issues with BCF',
  description: 'Flag a problem, capture viewpoints, and export a .bcfzip your whole team can open.',
  minutes: 3,
  version: 1,
  panel: 'bcf',
  prerequisites: { modelLoaded: true },
  steps: [
    {
      id: 'open-panel',
      kind: 'action',
      anchor: activityAnchor('bcf'),
      placement: 'left',
      title: 'Open BCF issues',
      body: 'BCF is the open format for sharing issues between BIM tools. Open the BCF panel from the sidebar rail, or press Alt+3.',
      gate: { predicate: (s) => s.bcfPanelVisible },
    },
    {
      id: 'frame-problem',
      kind: 'canvas',
      title: 'Frame the problem',
      body: 'Click an element to select it and orbit so the issue is in view. The viewpoint you capture next records this selection with the camera.',
      // A stale selection must not auto-advance the step (same guard as the
      // welcome tour's select step).
      prepare: (store) => {
        store.getState().clearSelection();
        store.getState().clearEntitySelection();
      },
      gate: { predicate: (s) => s.selectedEntityId !== null || s.selectedEntityIds.size > 0 },
    },
    {
      id: 'create-issue',
      kind: 'action',
      anchor: TOUR_ANCHORS.bcfNewTopic,
      panel: 'bcf',
      placement: 'left',
      title: 'Create an issue',
      body: 'Click +, give the topic a short title, and click Create Topic. A snapshot of your current view is attached automatically.',
      arm: (state, ctx) => {
        ctx.baseline.topics = state.bcfProject ? state.bcfProject.topics.size : 0;
      },
      // The + button only exists in the LIST view; a stale active topic from
      // an earlier session would leave the panel in detail view. Backing out
      // is view-only (no data is touched).
      prepare: (store) => {
        store.getState().setActiveTopic(null);
      },
      gate: {
        predicate: (s, ctx) => s.bcfProject !== null && s.bcfProject.topics.size > ctx.baseline.topics,
      },
    },
    {
      id: 'capture-viewpoint',
      kind: 'action',
      anchor: TOUR_ANCHORS.bcfCaptureViewpoint,
      panel: 'bcf',
      placement: 'left',
      title: 'Capture another viewpoint',
      body: 'Orbit to a different angle, then click Capture. Each viewpoint stores the camera, a snapshot, and your selection.',
      // addTopic auto-selects the new topic, so the detail view (and its
      // Capture button) is on screen here. The create step usually attached
      // viewpoint #1; baseline so only a NEW capture completes the step.
      arm: (state, ctx) => {
        const topic = state.getActiveTopic();
        ctx.baseline.viewpoints = topic ? topic.viewpoints.length : 0;
      },
      gate: {
        predicate: (s, ctx) => {
          const topic = s.getActiveTopic();
          return topic !== null && topic.viewpoints.length > ctx.baseline.viewpoints;
        },
      },
    },
    {
      id: 'export-bcf',
      kind: 'action',
      anchor: TOUR_ANCHORS.bcfExport,
      panel: 'bcf',
      placement: 'left',
      title: 'Export BCF',
      body: 'Click the download icon in the header. The .bcfzip opens in Revit, Navisworks, Solibri, and other BCF tools; a returned one imports via the button next to it.',
      // The export funnels through downloadBlob -> the shared download choke
      // point, which emits the file-downloaded event with the extension.
      gate: { event: EVENT_FILE_DOWNLOADED, eventKind: 'bcfzip', hintAfterMs: 30_000 },
    },
  ],
};
