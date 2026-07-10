/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measure and section tour: the canvas tool kit most other walkthroughs
 * assume the user already knows - ViewCube presets, a drag-based distance
 * measurement, and a face-picked section cut. Target: about three minutes.
 */

import { TOUR_ANCHORS, toolAnchor } from '../anchors';
import { EVENT_CAMERA_INTERACTED } from '../events';
import type { TourDefinition } from '../types';

export const MEASURE_SECTION_TOUR: TourDefinition = {
  id: 'measure-section',
  title: 'Measure and section the model',
  description: 'Jump to a standard view, measure a distance, and cut through the model with a section plane.',
  minutes: 3,
  version: 1,
  prerequisites: { modelLoaded: true },
  // The measurement and the section cut are the user's own work products.
  // Keep the cut visible after a successful finish; an abort still restores
  // the pre-tour plane automatically via the engine snapshot. Measurements
  // are never part of the snapshot, so they always survive both paths.
  keepOnFinish: ['sectionPlane'],
  steps: [
    {
      id: 'viewcube',
      kind: 'action',
      anchor: TOUR_ANCHORS.viewcube,
      // Left placement keeps the card off the top-right corner so the
      // cube itself is never covered.
      placement: 'left',
      title: 'Jump to a standard view',
      body: 'Click a face of the cube to snap the camera to that view. Drag it to orbit freely.',
      gate: { event: EVENT_CAMERA_INTERACTED, eventKind: 'preset' },
    },
    {
      id: 'tool-measure',
      kind: 'action',
      anchor: toolAnchor('measure'),
      title: 'Open the Measure tool',
      body: 'Click the ruler in the toolbar, or press M.',
      gate: { predicate: (s) => s.activeTool === 'measure' },
    },
    {
      id: 'measure-distance',
      kind: 'canvas',
      title: 'Measure a distance',
      body: 'Press and drag from one point to another. Snap markers lock onto corners, edges, and faces. Release to place the measurement.',
      arm: (state, ctx) => {
        ctx.baseline.measurements = state.measurements.length;
      },
      gate: { predicate: (s, ctx) => s.measurements.length > ctx.baseline.measurements },
    },
    {
      id: 'tool-section',
      kind: 'action',
      anchor: toolAnchor('section'),
      title: 'Open the Section tool',
      body: 'Click the scissors in the toolbar, or press X.',
      gate: { predicate: (s) => s.activeTool === 'section' },
    },
    {
      id: 'cut-face',
      kind: 'canvas',
      title: 'Cut through a face',
      body: 'Hover a wall or slab to preview the cut, then click to slice through it. If nothing previews, click Pick face in the Section panel.',
      // The Section panel auto-restores the last mode on mount: a returning
      // "cardinal" user can land here with `enabled` already true. Baseline
      // it so the fallback only fires on a genuine change, not a restore.
      arm: (state, ctx) => {
        ctx.baseline.sectionEnabled = state.sectionPlane.enabled ? 1 : 0;
      },
      gate: {
        predicate: (s, ctx) =>
          s.sectionPlane.custom !== undefined ||
          (s.sectionPlane.enabled && ctx.baseline.sectionEnabled === 0),
      },
    },
    {
      id: 'slide-cut',
      kind: 'action',
      anchor: TOUR_ANCHORS.sectionPanel,
      title: 'Slide the cut',
      body: 'Expand the panel and drag the position slider, or type an exact distance. Flip swaps which side stays visible.',
      arm: (state, ctx) => {
        ctx.baseline.sectionPosition = state.sectionPlane.position;
        ctx.baseline.sectionCustomDistance = state.sectionPlane.custom?.distance ?? 0;
      },
      gate: {
        predicate: (s, ctx) =>
          s.sectionPlane.position !== ctx.baseline.sectionPosition ||
          (s.sectionPlane.custom?.distance ?? 0) !== ctx.baseline.sectionCustomDistance,
      },
    },
    {
      id: 'wrap',
      kind: 'canvas',
      title: 'All set',
      body: 'That is the canvas kit. More tours live in the Learn hub.',
    },
  ],
};
