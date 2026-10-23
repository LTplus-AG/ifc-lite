/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Named section cuts (#5514, charter #5478): a small library of saved cut
 * geometries a user can name, re-apply, rename, and delete. Listed in the
 * Drawing panel as the drawing's source; applying one becomes THE visible
 * cut (`useViewerStore`'s `sectionPlane`), so BCF viewpoint capture
 * (`useSectionViewpointCapture.ts`, reads `drawing2D.config.plane`) and the
 * floor-plan command (`useFloorplanView.ts`, reads/writes the same
 * `sectionPlane`) get it for free — neither has to know saved cuts exist.
 *
 * Lives in its OWN zustand store, not a `ViewerState` slice, for two
 * reasons:
 *
 *  1. `store/index.ts` and `slices/sectionSlice.ts` are both already at
 *     their `check-module-size` ratchet with zero headroom (#5478 house
 *     rule: never raise a budget). A same-shaped contribution to either
 *     would fail CI on line count alone; splitting `sectionSlice.ts` to buy
 *     room is a larger, riskier PR than this feature justifies.
 *  2. A saved cut is a document the user authored, like a `BasketView`
 *     preset (`pinboardSlice.ts`) — the same reasoning that keeps
 *     `basketViews` out of the `'all-models-cleared'` teardown arm applies
 *     here without qualification: this store is never torn down by a model
 *     swap. Its geometry (axis/position/custom) can go stale relative to a
 *     very different model's bounds, exactly like a `BasketView`'s
 *     `entityRefs` can — a soft UX question, not a correctness bug, and one
 *     the existing precedent already accepts.
 *
 * A saved cut is a SET (#7545): every plane that was cutting, which of them was
 * active, the zoom the user last used and the exact camera, so applying it brings
 * back the view and not only the geometry. A set of one plane is what a saved cut
 * always was, so the Drawing panel's list, rename and delete keep working.
 *
 * The only coupling to the main store is one-directional and explicit:
 * `saveCurrentSectionCut` reads the live plane set, and `applySavedSectionCut`
 * installs it through `installSectionPlanes` (fresh ids, unique names, un-hidden)
 * and opens the Section tool - so a saved cut re-enters the Section/Drawing
 * contract (`store/section-active.ts`) exactly like every other section writer.
 */

import { create } from 'zustand';
import type { CameraViewpoint, SectionBox, SectionCapStyle, SectionPlane, SectionPlaneAxis } from './types.js';
import { useViewerStore } from './index.js';
import { getDefaultSectionPlane } from './slices/sectionSlice.js';
import { orderedSectionPlanes, sectionPlaneCount } from '@/lib/section/section-plane-set';
import { zoomToSectionTarget } from '@/lib/section/section-zoom';
import type { SectionZoomSpec } from '@/lib/section/section-zoom-spec';

/** The subset of `SectionPlane` that defines the CUT itself, not its
 *  on-screen/parked lifecycle (`enabled` / `parked`), which only ever means
 *  something for the currently active tool. */
export interface SavedSectionCutPlane {
  /** The plane's chip name; absent in cuts saved before the set existed. */
  name?: string;
  axis: SectionPlaneAxis;
  position: number;
  flipped: boolean;
  custom?: SectionPlane['custom'];
  /** A box cut (#5513): the plane IS this box. */
  box?: SectionBox;
  capStyle: SectionCapStyle;
  showCap: boolean;
  showOutlines: boolean;
}

export interface SavedSectionCut {
  id: string;
  name: string;
  /** Every plane that was cutting, in creation order. */
  planes: SavedSectionCutPlane[];
  /** Which of `planes` was the active one. */
  activeIndex: number;
  /** The zoom the user had chosen; applied when there is no exact camera. */
  zoom: SectionZoomSpec | null;
  /** The exact camera when the set was saved, so applying it is a restore and not a re-frame. */
  viewpoint: CameraViewpoint | null;
  createdAt: number;
  updatedAt: number;
}

interface SavedSectionCutsState {
  cuts: SavedSectionCut[];
  /** The saved cut currently on screen, if the live cut still matches one
   *  exactly (cleared the moment the user edits the cut further). */
  activeCutId: string | null;
}

function createCutId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `section-cut-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function planeSnapshot(plane: SectionPlane): SavedSectionCutPlane {
  return {
    name: plane.name,
    axis: plane.axis,
    position: plane.position,
    flipped: plane.flipped,
    custom: plane.custom,
    box: plane.box,
    capStyle: plane.capStyle,
    showCap: plane.showCap,
    showOutlines: plane.showOutlines,
  };
}

export const useSavedSectionCuts = create<SavedSectionCutsState>()(() => ({
  cuts: [],
  activeCutId: null,
}));

/** Whether there is a cut to save: a viewer with no plane yet holds only an untouched placeholder. */
export function canSaveSectionCut(state: Pick<ReturnType<typeof useViewerStore.getState>, 'sectionPlane' | 'inactiveSectionPlanes'> = useViewerStore.getState()): boolean {
  return sectionPlaneCount(state.sectionPlane, state.inactiveSectionPlanes) > 0;
}

/**
 * Save the live cut as a new named set: every plane that is cutting (all of them,
 * active first when none is), with the zoom and the camera as they are now. Returns its id.
 */
export function saveCurrentSectionCut(name: string): string {
  const state = useViewerStore.getState();
  // The untouched placeholder is not a cut: saving it would store a plane that cuts the model when applied.
  if (!canSaveSectionCut(state)) throw new Error('saveCurrentSectionCut: there is no cutting plane to save');
  const all = orderedSectionPlanes(state.sectionPlane, state.inactiveSectionPlanes);
  const cutting = all.filter((p) => p.enabled);
  const planes = cutting.length > 0 ? cutting : [state.sectionPlane];
  const id = createCutId();
  const now = Date.now();
  const cut: SavedSectionCut = {
    id,
    name,
    planes: planes.map(planeSnapshot),
    activeIndex: Math.max(0, planes.findIndex((p) => p.id === state.sectionPlane.id)),
    zoom: state.sectionZoom,
    viewpoint: state.cameraCallbacks.getViewpoint?.() ?? null,
    createdAt: now,
    updatedAt: now,
  };
  useSavedSectionCuts.setState((s) => ({ cuts: [...s.cuts, cut], activeCutId: id }));
  return id;
}

/**
 * Put a saved set ON SCREEN. It REPLACES the whole plane set (active and inactive;
 * a leftover box or plane from before must not keep cutting beside it), un-hides it
 * (`sceneState.section.visible`, #5893 - like `basketViewActivator.ts`'s section
 * branch, a stale `visible: false` left by an earlier chip-hide must not survive a
 * saved cut being applied fresh, or it renders nothing with no chip open to explain
 * why), opens the Section tool so the user can see and edit what they just applied,
 * and then restores the exact camera, or frames the saved zoom when there is none.
 */
export function applySavedSectionCut(id: string): void {
  const cut = useSavedSectionCuts.getState().cuts.find((c) => c.id === id);
  if (!cut) return;
  const state = useViewerStore.getState();
  const base = getDefaultSectionPlane();
  const planes: SectionPlane[] = cut.planes.map((saved) => ({
    ...base,
    ...saved,
    name: saved.name ?? '',
    enabled: true,
    parked: false,
  }));
  state.installSectionPlanes(planes, cut.activeIndex);
  useViewerStore.setState({ sceneState: { ...useViewerStore.getState().sceneState, section: { visible: true } } });
  if (useViewerStore.getState().activeTool !== 'section') {
    useViewerStore.getState().setActiveTool('section');
  }
  useSavedSectionCuts.setState({ activeCutId: id });
  const live = useViewerStore.getState();
  if (cut.viewpoint && live.cameraCallbacks.applyViewpoint) live.cameraCallbacks.applyViewpoint(cut.viewpoint, true);
  else if (cut.zoom) void zoomToSectionTarget(live, cut.zoom);
}

export function renameSavedSectionCut(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  useSavedSectionCuts.setState((s) => ({
    cuts: s.cuts.map((c) => (c.id === id ? { ...c, name: trimmed, updatedAt: Date.now() } : c)),
  }));
}

export function removeSavedSectionCut(id: string): void {
  useSavedSectionCuts.setState((s) => ({
    cuts: s.cuts.filter((c) => c.id !== id),
    activeCutId: s.activeCutId === id ? null : s.activeCutId,
  }));
}
