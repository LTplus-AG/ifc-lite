/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The BCF slice's contribution to viewer-state teardown.
 *
 * A sibling module rather than a block at the bottom of `bcfSlice.ts` because
 * that file is 381 lines and this table plus its comments would take it past
 * the ~400-line module rule (`scripts/check-module-size.mjs`).
 */

import { defineSliceTeardown, notApplicable } from '../teardown.js';

/**
 * What a session reset clears on the BCF slice.
 *
 * Carried verbatim from `resetViewerState` (`store/index.ts`):
 *   "BCF - reset panel but keep project and author"
 *   "Keep bcfProject and bcfAuthor - user's work"
 *
 * A BCF project is a collaboration document, not model state — it names topics
 * against a whole coordination job and routinely outlives any single file the
 * user has open, so it is absent from `owns`. `bcfAuthor` is a workspace
 * identity, likewise. `bcfOverlayVisible` is absent for the same reason
 * `resetViewerState` never touched it: it is a display preference for the 3D
 * markers, and the markers belong to the surviving project.
 *
 * `clearBcfProject()` is NOT folded in: it drops `bcfProject` itself, which
 * this teardown must not do.
 */
export const bcfTeardown = defineSliceTeardown(
  'bcfSlice',
  ['bcfPanelVisible', 'bcfLoading', 'bcfError', 'activeTopicId', 'activeViewpointId'],
  {
    'session-reset': () => ({
      bcfPanelVisible: false,
      bcfLoading: false,
      bcfError: null,
      // The active topic and viewpoint are a reading position inside the
      // surviving project, and a viewpoint restores a camera pose plus a
      // visibility set expressed against the OUTGOING model. The project
      // stays; where the user was in it does not.
      activeTopicId: null,
      activeViewpointId: null,
    }),
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);
