/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `drawing2DSlice`'s answer to "what do I destroy under this scope".
 *
 * Lives beside the slice rather than inside it because `drawing2DSlice.ts` is
 * at its recorded module-size budget (`scripts/module-size-allowlist.txt`),
 * and that ratchet goes down by default. The seam is real either way: this file
 * is the reviewable list of everything the slice is willing to lose, and the
 * only consumer is the store's teardown registry.
 *
 * Every value is picked off {@link getDefaultDrawing2DState}, the slice's own
 * initial state, so the two cannot drift — that duplication (`store/index.ts`
 * restating each value a second time, in a file that cannot see the slice) is
 * what `store/teardown.ts` exists to remove.
 *
 * ## What must SURVIVE — and why the body is a hand-written field list
 *
 * `graphicOverridePresets` (the built-in preset library) and `dxfUnderlays`
 * (imported reference drawings) belong to the workspace, not to the loaded
 * file. They are absent from `owns` and from the body, which is the whole
 * point of naming fields one by one: this slice is confirmed bug #2 in
 * `scripts/check-whole-state-reset.mjs`'s header (issue #2802) — `clearDrawing2D`
 * once did `set(getDefaultState())` and destroyed custom override rules,
 * `overridesEnabled`, text annotations and DXF underlays. A `...defaults`
 * spread here would reintroduce exactly that, silently.
 *
 * `clearDrawing2D` is deliberately NOT folded into this: it is a scoped action
 * with a DIFFERENT contract (regenerate the drawing, keep everything the user
 * authored), and collapsing the two is the mistake #2802 records.
 */

import { defineSliceTeardown, notApplicable } from '../teardown.js';
import { getDefaultDrawing2DState } from './drawing2DSlice.js';
import { markupTransitionPatch } from './drawing2DSlice.markupTransition.js';

export const drawing2DTeardown = defineSliceTeardown(
  'drawing2DSlice',
  [
    'drawing2D',
    'drawing2DStatus',
    'drawing2DProgress',
    'drawing2DPhase',
    'drawing2DError',
    'drawing2DPanelVisible',
    'suppressNextSection2DPanelAutoOpen',
    'drawing2DSvgContent',
    'drawing2DDisplayOptions',
    'activePresetId',
    'customOverrideRules',
    'overridesEnabled',
    'overridesPanelVisible',
    'measure2DMode',
    'measure2DStart',
    'measure2DCurrent',
    'measure2DShiftLocked',
    'measure2DLockedAxis',
    'measure2DResults',
    'measure2DSnapPoint',
    'annotation2DActiveTool',
    'annotation2DCursorPos',
    'polygonArea2DPoints',
    'polygonArea2DResults',
    'textAnnotations2D',
    'textAnnotation2DEditing',
    'cloudAnnotation2DPoints',
    'cloudAnnotations2D',
    'selectedAnnotation2D',
  ],
  {
    'session-reset': () => {
      const defaults = getDefaultDrawing2DState();
      return {
        // Drawing 2D
        drawing2D: defaults.drawing2D,
        drawing2DStatus: defaults.drawing2DStatus,
        drawing2DProgress: defaults.drawing2DProgress,
        drawing2DPhase: defaults.drawing2DPhase,
        drawing2DError: defaults.drawing2DError,
        drawing2DPanelVisible: defaults.drawing2DPanelVisible,
        suppressNextSection2DPanelAutoOpen: defaults.suppressNextSection2DPanelAutoOpen,
        drawing2DSvgContent: defaults.drawing2DSvgContent,
        drawing2DDisplayOptions: defaults.drawing2DDisplayOptions,

        // Graphic overrides (keep presets, reset active and custom)
        activePresetId: defaults.activePresetId,
        customOverrideRules: defaults.customOverrideRules,
        overridesEnabled: defaults.overridesEnabled,
        overridesPanelVisible: defaults.overridesPanelVisible,

        // 2D Measure
        measure2DMode: defaults.measure2DMode,
        measure2DStart: defaults.measure2DStart,
        measure2DCurrent: defaults.measure2DCurrent,
        measure2DShiftLocked: defaults.measure2DShiftLocked,
        measure2DLockedAxis: defaults.measure2DLockedAxis,
        measure2DResults: defaults.measure2DResults,
        measure2DSnapPoint: defaults.measure2DSnapPoint,

        // Annotation tools
        annotation2DActiveTool: defaults.annotation2DActiveTool,
        annotation2DCursorPos: defaults.annotation2DCursorPos,
        polygonArea2DPoints: defaults.polygonArea2DPoints,
        polygonArea2DResults: defaults.polygonArea2DResults,
        textAnnotations2D: defaults.textAnnotations2D,
        textAnnotation2DEditing: defaults.textAnnotation2DEditing,
        cloudAnnotation2DPoints: defaults.cloudAnnotation2DPoints,
        cloudAnnotations2D: defaults.cloudAnnotations2D,
        selectedAnnotation2D: defaults.selectedAnnotation2D,
      };
    },
    // The generated drawing, its overrides and its annotations are all keyed
    // to the file that was loaded. Clearing every model leaves the 2D view
    // to be regenerated on demand and must not throw away the user's markup,
    // so that scope is a no-op here — same reasoning as `'model-removed'`
    // below when the removed model was NOT the active one.
    //
    // #4159 bug 5: when the removed model WAS the active one,
    // `modelSlice.teardown.ts`'s own arm moves `activeModelId` to
    // `scope.nextActiveModelId` in this SAME composed patch — and until this
    // fix, nothing here followed it, so the flat markup fields kept
    // describing the just-removed model under the new active id's name
    // (leaking into it, or persisting over its own saved entry, exactly like
    // bug 2's ordinary switch — `removeModel` and `syncSourceModel`
    // (`lib/sources/syncSourceModel.ts`, which calls `removeModel` too) both
    // reach this). Delegating to `markupTransitionPatch` — the same function
    // `modelSlice.ts`'s `setActiveModel` calls — closes it: the function
    // itself no-ops (returns `{}`) when `scope.nextActiveModelId` equals the
    // CURRENT `activeModelId`, i.e. exactly the "removed model was not
    // active" case this arm used to hard-code as `notApplicable`.
    'model-removed': (scope, state) => {
      const defaults = getDefaultDrawing2DState();
      return markupTransitionPatch(
        {
          activeModelId: state.activeModelId ?? null,
          measure2DResults: state.measure2DResults ?? defaults.measure2DResults,
          polygonArea2DResults: state.polygonArea2DResults ?? defaults.polygonArea2DResults,
          textAnnotations2D: state.textAnnotations2D ?? defaults.textAnnotations2D,
          cloudAnnotations2D: state.cloudAnnotations2D ?? defaults.cloudAnnotations2D,
          drawing2DDisplayOptions: state.drawing2DDisplayOptions ?? defaults.drawing2DDisplayOptions,
        },
        scope.nextActiveModelId,
      );
    },
    'all-models-cleared': notApplicable,
  },
);
