/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lasting scene-state visibility for the section cut and finished
 * measurements (#5893, part of #5611 deliverable 3).
 *
 * Before this slice, both were owned by tool lifetime: `section-active.ts`
 * forced `sectionPlane.enabled` to `false` the instant `activeTool` left
 * `'section'` (parking the cut), and the measurement SVG only mounted while
 * `activeTool === 'measure'` (`ToolOverlays.tsx` reading `TOOL_HUD`). You
 * could not measure inside a section cut, and a finished measurement
 * vanished the moment you switched tools.
 *
 * `sceneState.section.visible` / `sceneState.measurements.visible` are the
 * two toggles that now own "is this on screen", independent of `activeTool`:
 *
 *  - the renderer gate (`useAnimationLoop.ts`, via `sectionRenderClip`)
 *    reads `sceneState.section.visible` instead of `activeTool === 'section'`;
 *  - the always-mounted `MeasurementSceneLayer` (mounted from the scene
 *    layer in `ViewportContainer`, not from the Measure tool) reads
 *    `sceneState.measurements.visible`;
 *  - `store/section-active.ts`'s `activeSectionPlane()` — the SDK, PDF
 *    export, BCF capture and grid-clip's one accessor for "the visible
 *    cut" — reads it too.
 *
 * Tools only ever edit the plane (`sectionSlice.ts`) or the measurements
 * (`measurementSlice.ts`); they no longer decide whether either draws.
 * Both default to `true` (shown as soon as there is something to show) and
 * are toggled from the HUD chips (`SectionParkedChip`,
 * `MeasurementsVisibilityChip`) and the visibility-reason registry
 * (`lib/visibility/visibility-reasons.ts`, #5869), so Show all / Home cover
 * them too.
 *
 * Teardown (#4249 completeness review): `sceneState` is world-space —
 * scoped to the whole loaded scene, not to any one federated model, the
 * same reasoning `sectionSlice.teardown.ts` gives for leaving `sectionPlane`
 * untouched by `model-removed`. Removing ONE model out of several leaves
 * the rest of the scene, and the toggles the user set for it, in place.
 * But a genuinely NEW scene — a fresh file load (`'session-reset'`) or
 * every model gone (`'all-models-cleared'`) — has nothing left for a
 * previous hide to describe, so both reset to `visible: true`: the next
 * cut or measurement in that scene should be shown, not silently born
 * hidden by a toggle the user set for a file that is no longer open.
 */

import type { StateCreator } from 'zustand';
import type { ViewerState } from '../index.js';
import { defineSliceTeardown, notApplicable } from '../teardown.js';

export interface SceneVisibilityState {
  section: { visible: boolean };
  measurements: { visible: boolean };
}

export interface SceneStateSlice {
  sceneState: SceneVisibilityState;
  setSectionVisible: (visible: boolean) => void;
  toggleSectionVisible: () => void;
  setMeasurementsVisible: (visible: boolean) => void;
  toggleMeasurementsVisible: () => void;
}

const defaultSceneState = (): SceneVisibilityState => ({ section: { visible: true }, measurements: { visible: true } });

export const createSceneStateSlice: StateCreator<ViewerState, [], [], SceneStateSlice> = (set) => ({
  sceneState: defaultSceneState(),

  // `sectionPlane.parked` (#4910) is kept in sync here for the readers that
  // predate this slice and read it directly (`DrawingPanel`, tours,
  // `basketViewActivator`): "parked" now means "enabled, but hidden by this
  // toggle" rather than "the tool is closed".
  setSectionVisible: (visible) => set((state) => ({
    sceneState: { ...state.sceneState, section: { visible } },
    sectionPlane: state.sectionPlane.enabled
      ? { ...state.sectionPlane, parked: !visible }
      : state.sectionPlane,
  })),

  toggleSectionVisible: () => set((state) => {
    const visible = !state.sceneState.section.visible;
    return {
      sceneState: { ...state.sceneState, section: { visible } },
      sectionPlane: state.sectionPlane.enabled
        ? { ...state.sectionPlane, parked: !visible }
        : state.sectionPlane,
    };
  }),

  setMeasurementsVisible: (visible) => set((state) => ({
    sceneState: { ...state.sceneState, measurements: { visible } },
  })),

  toggleMeasurementsVisible: () => set((state) => ({
    sceneState: { ...state.sceneState, measurements: { visible: !state.sceneState.measurements.visible } },
  })),
});

export const sceneStateTeardown = defineSliceTeardown('sceneStateSlice', ['sceneState'], {
  'session-reset': () => ({ sceneState: defaultSceneState() }),
  // A model out of several going away doesn't touch the rest of the
  // scene — see this file's own doc comment.
  'model-removed': notApplicable,
  'all-models-cleared': () => ({ sceneState: defaultSceneState() }),
});
