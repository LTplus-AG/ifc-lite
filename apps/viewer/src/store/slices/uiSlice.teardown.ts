/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `uiSlice`'s answer to "what do I destroy under this scope".
 *
 * Beside the slice rather than inside it because `uiSlice.ts` sits at its
 * recorded module-size budget (`scripts/module-size-allowlist.txt`), which
 * ratchets down by default.
 *
 * `owns` is a SMALL subset of what this slice holds, on purpose. The slice
 * also owns the panel-collapse flags, `hierarchyMode`, `theme`,
 * `hoverTooltipsEnabled`, `toolbarStyle`, the ribbon state and the geometry
 * load settings — workspace preferences, several of them persisted, none of
 * which a file swap has ever touched. They are absent from both `owns` and
 * the body, which is what a hand-written field list buys (issue #2802).
 *
 * Values come from `UI_DEFAULTS`, the same constants the slice's own initial
 * state is built from, so the reset value and the initial value are one fact.
 */

import { defineSliceTeardown, notApplicable } from '../teardown.js';
import { UI_DEFAULTS } from '../constants.js';

export const uiTeardown = defineSliceTeardown(
  'uiSlice',
  [
    'activeTool',
    'editEnabled',
    'pendingPropertyFocus',
    'visualEnhancementsEnabled',
    'edgeContrastEnabled',
    'edgeContrastIntensity',
    'contactShadingQuality',
    'contactShadingIntensity',
    'contactShadingRadius',
    'separationLinesEnabled',
    'separationLinesQuality',
    'separationLinesIntensity',
    'separationLinesRadius',
  ],
  {
    'session-reset': () => ({
      activeTool: UI_DEFAULTS.ACTIVE_TOOL,
      editEnabled: false,
      // Drop any one-shot bSDD "jump to property" focus armed before the
      // load — a new file reuses ids ('legacy' + reassigned expressIds) so
      // a stale focus could otherwise match an unrelated entity (#1107).
      pendingPropertyFocus: null,
      visualEnhancementsEnabled: UI_DEFAULTS.VISUAL_ENHANCEMENTS_ENABLED,
      edgeContrastEnabled: UI_DEFAULTS.EDGE_CONTRAST_ENABLED,
      edgeContrastIntensity: UI_DEFAULTS.EDGE_CONTRAST_INTENSITY,
      contactShadingQuality: UI_DEFAULTS.CONTACT_SHADING_QUALITY,
      contactShadingIntensity: UI_DEFAULTS.CONTACT_SHADING_INTENSITY,
      contactShadingRadius: UI_DEFAULTS.CONTACT_SHADING_RADIUS,
      separationLinesEnabled: UI_DEFAULTS.SEPARATION_LINES_ENABLED,
      separationLinesQuality: UI_DEFAULTS.SEPARATION_LINES_QUALITY,
      separationLinesIntensity: UI_DEFAULTS.SEPARATION_LINES_INTENSITY,
      separationLinesRadius: UI_DEFAULTS.SEPARATION_LINES_RADIUS,
    }),
    // Removing one model from a federation, or clearing them all, leaves the
    // chrome alone: the active tool and the render-quality toggles describe
    // the session, not the file. Only a file swap resets them.
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);
