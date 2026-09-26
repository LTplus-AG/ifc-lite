/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One source of truth for "the section cut is on screen" (#4806, #4910).
 *
 * The renderer only applies the cut while the Section tool is active
 * (`useAnimationLoop` / `buildRenderOptions` gate on `activeTool === 'section'`).
 * `sectionPlane.enabled` used to outlive the tool, so every consumer that read
 * it (SDK `getSection()`, view/PDF export, BCF capture, grid clipping, the scan
 * workbench guard) saw a cut the user could not see.
 *
 * The invariant is now held by the store itself: `sectionPlane.enabled` is
 * true ONLY while the Section tool is active. `registerSectionVisibility` below
 * is the single enforcer — a store subscription, so it covers every writer
 * (tool switches, the SDK, BCF apply, basket views, tours, direct `setState`):
 *
 *   - outside the tool, an enabled cut is PARKED (`enabled: false`,
 *     `parked: true`) — the geometry (axis/position/flipped/custom) stays;
 *   - inside the tool, a parked cut is resumed (`enabled: true`), so reopening
 *     the Section tool restores the last cut, face-picked planes included.
 *
 * `activeSectionPlane()` is kept as the named accessor for "the visible cut".
 */

import type { SectionPlane, SectionPlaneAxis } from './types.js';
import { clearLastSectionMode } from './slices/sectionSlice.js';
import { cardinalSectionFlipped } from './slices/sectionFacePick.js';
export { cardinalSectionFlipped };

interface SectionVisibilityState {
  activeTool: string;
  sectionPlane: SectionPlane;
}

export function activeSectionPlane(state: SectionVisibilityState): SectionPlane | null {
  return state.activeTool === 'section' && state.sectionPlane.enabled ? state.sectionPlane : null;
}

/** The patch that restores the invariant for `state`, or `null` when it already holds. */
export function sectionVisibilityPatch(state: SectionVisibilityState): { sectionPlane: SectionPlane } | null {
  const plane = state.sectionPlane;
  if (state.activeTool !== 'section') {
    return plane.enabled ? { sectionPlane: { ...plane, enabled: false, parked: true } } : null;
  }
  return plane.parked ? { sectionPlane: { ...plane, enabled: true, parked: false } } : null;
}

interface SectionVisibilityStore {
  getState: () => SectionVisibilityState;
  setState: (partial: { sectionPlane: SectionPlane }) => void;
  subscribe: (listener: (state: SectionVisibilityState) => void) => () => void;
}

export function registerSectionVisibility(store: SectionVisibilityStore): void {
  const reconcile = (state: SectionVisibilityState) => {
    const patch = sectionVisibilityPatch(state);
    if (patch) store.setState(patch);
  };
  store.subscribe(reconcile);
  reconcile(store.getState());
}

interface SectionWriterState extends SectionVisibilityState {
  setSectionPlaneAxis: (axis: SectionPlaneAxis) => void;
  setSectionPlanePosition: (position: number) => void;
  setSectionPlaneEnabled: (enabled: boolean) => void;
  flipSectionPlane: () => void;
  setActiveTool: (tool: string, via?: import('@/lib/analytics-ui-events').ToolChangeVia) => void;
}

/**
 * Put a cardinal cut ON SCREEN from outside the Section panel (BCF viewpoint,
 * SDK `setSection`). Goes through the slice actions, not `setState`, so the
 * last-used section mode is persisted too: the Section panel restores that
 * mode when it mounts, and would otherwise overwrite this cut with a stale one.
 */
export function showSectionCut(
  getState: () => SectionWriterState,
  cut: { axis: SectionPlaneAxis; position: number; flipped: boolean },
): void {
  const state = getState();
  state.setSectionPlaneAxis(cut.axis);
  state.setSectionPlanePosition(cut.position);
  if (getState().sectionPlane.flipped !== cut.flipped) state.flipSectionPlane();
  revealSectionCut(getState);
}

/** Put the current cut ON SCREEN: clipping on, and the Section tool (which draws it) open. */
export function revealSectionCut(getState: () => SectionWriterState): void {
  const state = getState();
  if (!state.sectionPlane.enabled) state.setSectionPlaneEnabled(true); // parked until the tool opens
  if (getState().activeTool !== 'section') {
    state.setActiveTool('section', 'programmatic');
  }
}

/**
 * No cut on screen, and none waiting for the next time the Section tool opens:
 * neither the parked cut nor the persisted last cardinal mode, which
 * SectionPanel re-applies (and re-enables) on mount.
 */
export function clearSectionCut(getState: () => SectionWriterState): void {
  const plane = getState().sectionPlane;
  if (plane.enabled || plane.parked) getState().setSectionPlaneEnabled(false);
  clearLastSectionMode();
}

/**
 * The Section panel's cardinal choice: its axis buttons, and "Reset to axis"
 * (the picked plane's own nearest `axis`, the default). Choosing the axis a
 * face-picked plane already approximates drops `custom` and keeps the side
 * that is on screen: a face pick's `flipped` is relative to its own normal
 * (#5644), so carrying it over raw inverts the cut for a -X/-Y/-Z pick (on
 * AC20-FZK-Haus the whole model vanished). Any other axis is a new cut and
 * goes straight to `setSectionPlaneAxis`. Not folded into that action: the
 * floor-plan view calls it with 'down', which is also a -Y pick's axis, and
 * must not turn into a reflected ceiling plan.
 */
export function resetSectionToAxis(
  getState: () => Pick<SectionWriterState, 'sectionPlane' | 'setSectionPlaneAxis' | 'flipSectionPlane'>,
  axis: SectionPlaneAxis = getState().sectionPlane.axis,
): void {
  const plane = getState().sectionPlane;
  if (!plane.custom || axis !== plane.axis) {
    getState().setSectionPlaneAxis(axis);
    return;
  }
  const flipped = cardinalSectionFlipped(plane);
  getState().setSectionPlaneAxis(axis);
  // With `custom` gone this flip is a cardinal one, so the slice persists it.
  if (getState().sectionPlane.flipped !== flipped) getState().flipSectionPlane();
}
