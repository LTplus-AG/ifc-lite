/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one "a user clicked an element" selection, shared by the 3D viewport
 * (`Viewport.tsx`) and the Model workspace's plan (`plan/PlanView.tsx`), so a
 * click selects the same way whichever view it lands in.
 *
 * Both channels are written (apps/viewer AGENTS.md, "Selection has two
 * channels"): the global id drives the renderer highlight and framing, the
 * resolved `EntityRef` drives the property panel.
 */

import { useViewerStore, resolveEntityRef } from '@/store';
import { selectLandXmlViewportPick } from './landXmlViewportSelection.js';
import { fieldTelemetry } from '@/lib/perf/fieldTelemetryLoader';

/** A plain click: select `globalId` alone, or clear the selection on a miss (null). */
export function selectPickedGlobalId(globalId: number | null): void {
  fieldTelemetry?.noteInspectSelection(globalId); // #6961: a sampled click's pick landed
  const state = useViewerStore.getState();
  // Gate on EITHER set: `selectedEntityIds` is the legacy global-id set that
  // drives the renderer highlight, and some features populate it WITHOUT the
  // multi-model `selectedEntitiesSet` (e.g. "isolate group members" (#1075)
  // and the clash-pair highlight). Checking only `selectedEntitiesSet` left
  // those highlights stuck on with no way to clear them by clicking away.
  if (state.selectedEntitiesSet.size > 0 || state.selectedEntityIds.size > 0) {
    useViewerStore.setState((s) => ({ selectedEntitiesSet: new Set(), selectedEntityIds: new Set(), selectionRevision: s.selectionRevision + 1 }));
  }
  if (globalId === null) {
    state.setSelectedEntityId(null);
    return;
  }
  if (selectLandXmlViewportPick(state, globalId)) return;
  state.setSelectedEntityId(globalId);
  state.setSelectedEntity(resolveEntityRef(globalId));
}

/** A multi-select click (Ctrl in 3D, Shift in the plan): add or remove `globalId`. */
export function toggleGlobalIdInSelection(globalId: number): void {
  const entityRef = resolveEntityRef(globalId);
  const state = useViewerStore.getState();
  // The first multi-select click keeps the existing single selection.
  if (state.selectedEntitiesSet.size === 0 && state.selectedEntity) {
    state.addEntityToSelection(state.selectedEntity);
    // Seed the global-id set too, so the renderer highlights both.
    if (state.selectedEntityId !== null) state.toggleSelection(state.selectedEntityId);
  }
  state.toggleEntitySelection(entityRef);
  state.toggleSelection(globalId);
  // Highlight what is left: the clicked element if it went ON, else the last remaining one.
  const updated = useViewerStore.getState();
  if (updated.selectedEntityIds.has(globalId)) {
    updated.setSelectedEntityId(globalId);
  } else {
    const remaining = Array.from(updated.selectedEntityIds);
    updated.setSelectedEntityId(remaining.length > 0 ? remaining[remaining.length - 1] : null);
  }
}
