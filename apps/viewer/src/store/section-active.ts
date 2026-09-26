/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One source of truth for "the section cut is on screen" (#4806, #4910,
 * #5893).
 *
 * Until #5893, the renderer only applied the cut while the Section tool was
 * active (`useAnimationLoop` gated on `activeTool === 'section'`) and this
 * module enforced that as a store invariant: `sectionPlane.enabled` was true
 * ONLY while the tool was open, forced off ("parked") the moment it closed.
 * That made the cut and the tool the same lifetime, so you could not measure
 * inside a section — opening Measure parked the cut — and a resumed cut
 * disappeared again the instant you left the tool for anything else.
 *
 * The cut is now lasting scene state: `sectionPlane.enabled` means "the user
 * has a cut turned on", independent of which tool is active, and
 * `sceneState.section.visible` (`store/slices/sceneStateSlice.ts`) is the
 * one further toggle that hides it without discarding it — the HUD chip
 * (`SectionParkedChip`) and the visibility-reason registry (#5869) drive
 * that toggle, not `activeTool`. `activeSectionPlane()` is the accessor every
 * consumer (SDK `getSection()`, view/PDF export, BCF capture, grid clipping,
 * the renderer gate) reads for "the visible cut": both `enabled` and
 * `sceneState.section.visible` must hold.
 *
 * `sectionPlane.parked` is kept for the readers that predate this slice
 * (`DrawingPanel`, tours, `basketViewActivator`) and now means "hidden — off
 * screen, but remembered rather than forgotten": either the cut is on
 * (`enabled: true`) and hidden by the visibility toggle (set by
 * `setSectionVisible` / `toggleSectionVisible`), or it was turned fully off
 * while a reader wanted to remember there was one (the historical
 * `enabled: false, parked: true` shape — no longer produced by a tool
 * switch, since #5893 removed the automatic forcing; a caller that wants
 * that shape sets it explicitly). There is deliberately no longer a store
 * subscription enforcing either combination: unlike pre-#5893, nothing
 * about the active tool should ever rewrite `sectionPlane` or `sceneState`
 * out from under an explicit `setState`.
 */

import type { SectionPlane, SectionPlaneAxis } from './types.js';
import type { SceneVisibilityState } from './slices/sceneStateSlice.js';
import { clearLastSectionMode } from './slices/sectionSlice.js';
import { cardinalSectionFlipped } from './slices/sectionFacePick.js';
export { cardinalSectionFlipped };

interface SectionVisibilityState {
  sectionPlane: SectionPlane;
  sceneState: SceneVisibilityState;
}

export function activeSectionPlane(state: SectionVisibilityState): SectionPlane | null {
  return state.sectionPlane.enabled && state.sceneState.section.visible ? state.sectionPlane : null;
}

interface SectionWriterState extends SectionVisibilityState {
  setSectionPlaneAxis: (axis: SectionPlaneAxis) => void;
  setSectionPlanePosition: (position: number) => void;
  setSectionPlaneEnabled: (enabled: boolean) => void;
  setSectionVisible: (visible: boolean) => void;
  flipSectionPlane: () => void;
  activeTool: string;
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

/** Put the current cut ON SCREEN: clipping on, the hide toggle cleared, and
 *  the Section tool (which lets the user edit it) open. */
export function revealSectionCut(getState: () => SectionWriterState): void {
  const state = getState();
  if (!state.sectionPlane.enabled) state.setSectionPlaneEnabled(true); // hidden until now
  if (!getState().sceneState.section.visible) getState().setSectionVisible(true);
  if (getState().activeTool !== 'section') {
    state.setActiveTool('section', 'programmatic');
  }
}

/**
 * No cut on screen, and none waiting for the next time the Section tool opens:
 * neither the hidden cut nor the persisted last cardinal mode, which
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
