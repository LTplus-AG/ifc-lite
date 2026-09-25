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
 * The only coupling to the main store is one-directional and explicit:
 * `saveCurrentSectionCut` reads `useViewerStore.getState().sectionPlane`,
 * and `applySavedSectionCut` writes it back through the same `setState` +
 * `setActiveTool` path `store/basket/basketViewActivator.ts` uses to restore
 * a `BasketSectionSnapshot` — so a saved cut re-enters the Section/Drawing
 * contract (`store/section-active.ts`) exactly like every other section
 * writer.
 */

import { create } from 'zustand';
import type { SectionCapStyle, SectionPlane, SectionPlaneAxis } from './types.js';
import { useViewerStore } from './index.js';

/** The subset of `SectionPlane` that defines the CUT itself, not its
 *  on-screen/parked lifecycle (`enabled` / `parked`), which only ever means
 *  something for the currently active tool. */
export interface SavedSectionCutPlane {
  axis: SectionPlaneAxis;
  position: number;
  flipped: boolean;
  custom?: SectionPlane['custom'];
  capStyle: SectionCapStyle;
  showCap: boolean;
  showOutlines: boolean;
}

export interface SavedSectionCut {
  id: string;
  name: string;
  plane: SavedSectionCutPlane;
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
    axis: plane.axis,
    position: plane.position,
    flipped: plane.flipped,
    custom: plane.custom,
    capStyle: plane.capStyle,
    showCap: plane.showCap,
    showOutlines: plane.showOutlines,
  };
}

export const useSavedSectionCuts = create<SavedSectionCutsState>()(() => ({
  cuts: [],
  activeCutId: null,
}));

/** Save the live section plane as a new named cut. Returns its id. */
export function saveCurrentSectionCut(name: string): string {
  const plane = useViewerStore.getState().sectionPlane;
  const id = createCutId();
  const now = Date.now();
  const cut: SavedSectionCut = { id, name, plane: planeSnapshot(plane), createdAt: now, updatedAt: now };
  useSavedSectionCuts.setState((s) => ({ cuts: [...s.cuts, cut], activeCutId: id }));
  return id;
}

/**
 * Put a saved cut ON SCREEN. Restores its full geometry (axis/position/
 * flipped/custom/cap style) into `sectionPlane` and, like
 * `basketViewActivator.ts`'s section branch, opens the Section tool so the
 * store-held invariant (`section-active.ts`: `enabled` only true while the
 * tool is active) resumes it rather than leaving it parked.
 */
export function applySavedSectionCut(id: string): void {
  const cut = useSavedSectionCuts.getState().cuts.find((c) => c.id === id);
  if (!cut) return;
  const current = useViewerStore.getState().sectionPlane;
  // A saved cut is a plane: leaving a live section box in place would keep
  // the box as the cut (#5513, `sectionRenderClip`), so it is dropped.
  useViewerStore.setState({ sectionPlane: { ...current, ...cut.plane, box: undefined, enabled: true, parked: false } });
  if (useViewerStore.getState().activeTool !== 'section') {
    useViewerStore.getState().setActiveTool('section');
  }
  useSavedSectionCuts.setState({ activeCutId: id });
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
