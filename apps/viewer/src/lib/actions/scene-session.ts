/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one active scene-action application and what it captured before it
 * changed anything — the restore point behind "Restore previous view".
 *
 * Each channel carries the ownership fact its restore is gated on, chosen to
 * match how that channel is already arbitrated elsewhere in the viewer:
 *
 *  - selection: `selectionRevision` after apply (monotonic; any later
 *    selection write bumps it), as the chart slice gates its claim;
 *  - isolate: the installed isolation set, tested BY VALUE through
 *    `lib/visibility/ownership.ts` like clash, IDS, lists and charts. The
 *    record lives here rather than in the viewer store, so the store's
 *    invalidation middleware cannot see it; the subscription below drops it
 *    the first time the channel stops showing exactly what was installed —
 *    the same "a stale value record is dangerous" rule (#2654) the middleware
 *    enforces for the store-held records;
 *  - hide: the ids this application added (ids the user had already hidden
 *    are never recorded, so restore cannot reveal them);
 *  - colour: `colorPresentationRevision` after the paint, the IDS colour
 *    claim's test (`lib/ids/color-ownership.ts`);
 *  - section: the `sectionPlane` object installed (every section write
 *    replaces it) plus the section visibility toggle;
 *  - camera: the prior viewpoint. The camera is navigation, not a shared
 *    channel, so Restore always returns to it when asked.
 */

import { create } from 'zustand';
import { sceneSourcesAreCurrent, type SceneSources } from './scene-source-ownership';
import { useViewerStore, type ViewerState } from '@/store';
import type { CameraViewpoint, EntityRef, SectionPlane } from '@/store/types';
import { ownsCurrentVisibility, type OwnedVisibilityRecords, type VisibilityOwnership } from '@/lib/visibility/ownership';

type RGBA = [number, number, number, number];

/** The ownership records over the shared isolate/ghost channels that a capture keeps. */
const CAPTURED_OWNERSHIP_RECORDS = [
  'idsFocusVisibilityOwned', 'clashVisibilityOwned', 'basketVisibilityOwned', 'chartVisibilityOwned', 'listVisibilityOwned',
] as const satisfies readonly (keyof OwnedVisibilityRecords)[];
export type CapturedRecords = Pick<ViewerState, typeof CAPTURED_OWNERSHIP_RECORDS[number]>;

export interface SelectionCapture {
  selectedEntityId: number | null;
  selectedEntityIds: number[];
  selectedEntity: EntityRef | null;
  selectedEntitiesSet: string[];
  selectedEntities: EntityRef[];
  selectedModelId: string | null;
}

export interface SceneApplication {
  id: string;
  title: string;
  /** Loaded-source ownership; model labels alone cannot identify a restore target. */
  sources: SceneSources;
  selection?: { prior: SelectionCapture; revision: number };
  isolate?: {
    prior: { isolated: Set<number> | null; ghost: Set<number> | null; records: CapturedRecords };
    /** Null once the channel stopped showing exactly what was installed. */
    claim: VisibilityOwnership;
  };
  hide?: { added: number[] };
  colour?: { prior: Map<number, RGBA>; revision: number; idsOwned: boolean };
  section?: { prior: SectionPlane; priorVisible: boolean; installed: SectionPlane; installedVisible: boolean };
  camera?: { prior: CameraViewpoint };
}

export type RestoreChannel = 'selection' | 'isolate' | 'hide' | 'colour' | 'section' | 'camera';
export type RestoreOutcome = 'restored' | 'changed' | 'unavailable' | 'models-changed';
export interface RestoreReport { title: string; channels: Array<{ channel: RestoreChannel; outcome: RestoreOutcome }> }

interface SceneSessionState {
  active: SceneApplication | null;
  /** The outcome of the most recent restore, for the card that offered it. */
  lastRestore: RestoreReport | null;
}

export const useSceneSession = create<SceneSessionState>(() => ({ active: null, lastRestore: null }));

let unsubscribe: (() => void) | null = null;

/** Revoke replaced sources and isolation claims as soon as their native ownership changes. */
function watchApplication(): void {
  unsubscribe?.();
  let seen: Set<number> | null = useViewerStore.getState().isolatedEntities;
  let seenModels = useViewerStore.getState().models;
  let seenStore = useViewerStore.getState().ifcDataStore;
  let seenGeometry = useViewerStore.getState().geometryResult;
  unsubscribe = useViewerStore.subscribe(state => {
    const application = useSceneSession.getState().active;
    if (!application) { unsubscribe?.(); unsubscribe = null; return; }
    if (state.models !== seenModels || state.ifcDataStore !== seenStore || state.geometryResult !== seenGeometry) {
      sceneSourcesAreCurrent(application.sources, state);
      seenModels = state.models; seenStore = state.ifcDataStore; seenGeometry = state.geometryResult;
    }
    // Channels are replaced wholesale, never mutated: an unchanged reference cannot have changed content.
    if (state.isolatedEntities === seen) return;
    seen = state.isolatedEntities;
    const active = useSceneSession.getState().active;
    if (!active?.isolate?.claim) return;
    if (!ownsCurrentVisibility(state, active.isolate.claim)) {
      useSceneSession.setState({ active: { ...active, isolate: { ...active.isolate, claim: null } } });
    }
  });
}

export function setActiveApplication(application: SceneApplication | null, lastRestore: RestoreReport | null = null): void {
  useSceneSession.setState({ active: application, lastRestore });
  if (application) watchApplication();
  else { unsubscribe?.(); unsubscribe = null; }
}

export function captureSelection(state: ViewerState): SelectionCapture {
  return {
    selectedEntityId: state.selectedEntityId,
    selectedEntityIds: [...state.selectedEntityIds],
    selectedEntity: state.selectedEntity,
    selectedEntitiesSet: [...state.selectedEntitiesSet],
    selectedEntities: [...state.selectedEntities],
    selectedModelId: state.selectedModelId,
  };
}

export function captureRecords(state: ViewerState): CapturedRecords {
  return {
    idsFocusVisibilityOwned: state.idsFocusVisibilityOwned ?? null,
    clashVisibilityOwned: state.clashVisibilityOwned ?? null,
    basketVisibilityOwned: state.basketVisibilityOwned ?? null,
    chartVisibilityOwned: state.chartVisibilityOwned ?? null,
    listVisibilityOwned: state.listVisibilityOwned ?? null,
  };
}
