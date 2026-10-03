/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Welcome tour: the first-run core loop. One aha moment - click a thing in
 * 3D and instantly read its BIM data - with load, camera, hierarchy, and
 * discovery around it. Target: about 2 minutes.
 */

import { TOUR_ANCHORS } from '../anchors';
import { ensureTourModel, loadDemoProject } from '../demo-kit';
import { EVENT_CAMERA_INTERACTED } from '../events';
import type { TourDefinition, ViewerStoreApi } from '../types';

/**
 * The element "Read its data" shows when the user skipped "Select an
 * element" (13 skips in the field): a wall when the model has one, else the
 * first meshed element. Scene meshes carry federated GLOBAL ids, which is
 * what `setSelectedEntityId` takes; `useModelSelection` resolves the
 * EntityRef the Information panel reads.
 */
export function representativeElementId(store: ViewerStoreApi): number | null {
  let fallback: number | null = null;
  for (const model of store.getState().models.values()) {
    for (const mesh of model.geometryResult?.meshes ?? []) {
      if (mesh.ifcType?.startsWith('IfcWall')) return mesh.expressId;
      fallback ??= mesh.expressId;
    }
  }
  return fallback;
}

/**
 * The selection `inspect` made on the user's behalf, if any: the id plus the
 * store's `selectionRevision` right after it, so ANY later selection change
 * (even re-picking the same element) marks the selection as the user's.
 */
let autoSelection: { id: number; revision: number } | null = null;

/**
 * Drop the tour's own selection when the tour ends (finish or abort), but
 * only while nothing has touched the selection since: one the user made is
 * theirs. On every step from `inspect` on, since a SKIPPED step's cleanup
 * never runs; the cleanups are idempotent.
 */
function clearAutoSelection(store: ViewerStoreApi): void {
  const auto = autoSelection;
  autoSelection = null;
  const s = store.getState();
  if (auto === null || s.selectedEntityId !== auto.id || s.selectionRevision !== auto.revision) return;
  s.clearSelection();
  s.clearEntitySelection();
}

export const WELCOME_TOUR: TourDefinition = {
  id: 'welcome',
  title: 'Get started',
  description: 'Load a model, look around, and read BIM data. The core loop in about two minutes.',
  minutes: 2,
  // 2: right-drag became fly navigation (#4864); completed users see the new orbit step.
  version: 2,
  // The element the user selects in "Select an element" (and any storey they
  // focus) is their outcome: a normal finish keeps it instead of restoring
  // the pre-tour selection. The tour's OWN auto-selection is still dropped
  // by `clearAutoSelection`, which runs before the restore. Abort restores
  // everything, as for every tour.
  keepOnFinish: ['selection'],
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
      skipLoadsDemo: true,
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
      body: 'Drag to orbit. Middle-drag or Shift+drag to pan. Scroll to zoom. Hold right-click to fly with WASD.',
      // Load skipped with nothing open: every step from here needs a model,
      // so the demo project stands in rather than the rest of the tour
      // pointing at an empty viewer.
      prepare: () => ensureTourModel(),
      gate: { event: EVENT_CAMERA_INTERACTED },
    },
    {
      id: 'select',
      kind: 'canvas',
      title: 'Select an element',
      body: 'Click any element in the 3D view to select it. Click empty space to deselect.',
      prepare: async (store) => {
        await ensureTourModel();
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
      prepare: async (store) => {
        // Skipped load or select must not leave this step reading an empty
        // panel: the Quantities tab only exists for a selected element.
        await ensureTourModel();
        if (store.getState().selectedEntityId === null) {
          const id = representativeElementId(store);
          if (id !== null) {
            // Scalar clears a model-header selection; the set drives the
            // renderer highlight (apps/viewer/AGENTS.md: two channels).
            store.getState().setSelectedEntityId(id);
            store.getState().setSelectedEntityIds([id]);
            autoSelection = { id, revision: store.getState().selectionRevision };
          }
        }
        store.getState().showWorkspacePanel('properties', 'programmatic');
        store.getState().setPropertiesActiveTab('properties');
      },
      gate: { predicate: (s) => s.propertiesActiveTab === 'quantities' },
      cleanup: clearAutoSelection,
    },
    {
      id: 'structure',
      kind: 'action',
      anchor: TOUR_ANCHORS.hierarchyPanel,
      placement: 'right',
      title: 'Browse the structure',
      body: 'The tree mirrors the model: site, building, storeys, elements. Click a storey name to focus it in 3D.',
      prepare: async (store) => {
        await ensureTourModel();
        store.getState().setLeftPanelCollapsed(false);
        store.getState().clearStoreySelection();
        store.getState().setActiveStorey(null);
      },
      gate: { predicate: (s) => s.activeStorey !== null },
      cleanup: clearAutoSelection,
    },
    {
      id: 'wrap',
      kind: 'canvas',
      title: 'Keep exploring',
      body: 'Press Cmd+K or Ctrl+K for the command palette, / to search, and ? for shortcuts. More tours live in the Learn hub. That is the core loop: load, orbit, select, inspect.',
      cleanup: clearAutoSelection,
    },
  ],
};
