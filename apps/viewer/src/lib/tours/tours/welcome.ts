/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Welcome tour: the first-run core loop. One aha moment - click a thing in
 * 3D and instantly read its BIM data - with load, camera, hierarchy, and
 * discovery around it. Target: about 2 minutes.
 */

import { TOUR_ANCHORS } from '../anchors';
import { loadDemoProject } from '../demo-kit';
import { EVENT_CAMERA_INTERACTED } from '../events';
import type { TourDefinition } from '../types';

export const WELCOME_TOUR: TourDefinition = {
  id: 'welcome',
  title: 'Get started',
  description: 'Load a model, look around, and read BIM data. The core loop in about two minutes.',
  minutes: 2,
  version: 1,
  steps: [
    {
      id: 'load',
      kind: 'action',
      anchor: TOUR_ANCHORS.emptyStateCard,
      placement: 'right',
      title: 'Load a model',
      body: 'Open an .ifc file or drop one anywhere in the window. No file handy? Load the demo project instead.',
      action: {
        label: 'Load demo project',
        run: () => loadDemoProject(),
      },
      expectsModelLoad: true,
      gate: {
        predicate: (s) => s.models.size > 0 && !s.loading && !s.geometryStreamingActive,
        // Parsing a real file takes a moment; do not nag with the hint early.
        hintAfterMs: 30_000,
      },
    },
    {
      id: 'orbit',
      kind: 'canvas',
      title: 'Look around',
      body: 'Drag to orbit. Right-drag to pan. Scroll to zoom.',
      gate: { event: EVENT_CAMERA_INTERACTED },
    },
    {
      id: 'select',
      kind: 'canvas',
      title: 'Select an element',
      body: 'Click any element in the 3D view to select it. Click empty space to deselect.',
      prepare: (store) => {
        // A stale selection must not auto-advance the step.
        store.getState().clearSelection();
        store.getState().clearEntitySelection();
      },
      gate: { predicate: (s) => s.selectedEntityId !== null },
    },
    {
      id: 'inspect',
      kind: 'action',
      anchor: TOUR_ANCHORS.propertiesPanel,
      panel: 'properties',
      placement: 'left',
      title: 'Read its data',
      body: 'The Information panel lists attributes and property sets for the selection. Open the Quantities tab to see areas and volumes.',
      prepare: (store) => {
        store.getState().showWorkspacePanel('properties');
        store.getState().setPropertiesActiveTab('properties');
      },
      gate: { predicate: (s) => s.propertiesActiveTab === 'quantities' },
    },
    {
      id: 'structure',
      kind: 'action',
      anchor: TOUR_ANCHORS.hierarchyPanel,
      placement: 'right',
      title: 'Browse the structure',
      body: 'The tree mirrors the model: site, building, storeys, elements. Click a storey name to focus it in 3D.',
      prepare: (store) => {
        store.getState().setLeftPanelCollapsed(false);
        store.getState().clearStoreySelection();
        store.getState().setActiveStorey(null);
      },
      gate: { predicate: (s) => s.activeStorey !== null },
    },
    {
      id: 'wrap',
      kind: 'canvas',
      title: 'Keep exploring',
      body: 'Press Cmd+K or Ctrl+K for the command palette, / to search, and ? for shortcuts. More tours live in the Learn hub. That is the core loop: load, orbit, select, inspect.',
    },
  ],
};
