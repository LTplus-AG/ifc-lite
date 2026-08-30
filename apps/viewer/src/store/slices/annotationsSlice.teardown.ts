/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `annotationsSlice`'s answer to "what do I destroy under this scope".
 *
 * `annotations` is NOT in `owns`. The pins are a cross-file workspace that
 * round-trips to localStorage, so they outlive every scope here — wiping them
 * is `clearAllAnnotations`, a user action, and it is deliberately not folded
 * into this: it also clears persisted storage, which a teardown must never do.
 *
 * The two values below are the slice's own initial values (`annotationsSlice.ts`,
 * `createAnnotationsSlice`), which `store/index.ts` restated a second time.
 */

import { defineSliceTeardown, notApplicable } from '../teardown.js';

export const annotationsTeardown = defineSliceTeardown('annotationsSlice', ['draft', 'selectedAnnotationId'], {
  'session-reset': () => ({
    // Drop draft + selection so a new file doesn't inherit the previous
    // file's pin authoring state. Persisted pins themselves stay in
    // localStorage (cross-file workspace).
    draft: null,
    selectedAnnotationId: null,
  }),
  // Pin authoring is not per-model: removing one model from a federation, or
  // clearing them all, leaves an open draft and its popover alone.
  'model-removed': notApplicable,
  'all-models-cleared': notApplicable,
});
