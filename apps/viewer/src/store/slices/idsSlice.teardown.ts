/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IDS slice's contribution to viewer-state teardown.
 *
 * A sibling module rather than a block at the bottom of `idsSlice.ts` because
 * that file sits at its recorded module-size budget (482 lines,
 * `scripts/module-size-allowlist.txt`), which a raise could lift but a
 * split does not need. The seam is real
 * either way: this answers "what does IDS destroy under a scope", which is a
 * different question from "how does IDS behave", and it has different rules —
 * pure, no `set`, no `get`, no release call.
 */

import { defineSliceTeardown, notApplicable } from '../teardown.js';

/**
 * What a session reset clears on the IDS slice.
 *
 * Carried verbatim from `resetViewerState` (`store/index.ts`):
 *   "IDS - reset panel but keep document and results"
 *   "Keep idsDocument, idsValidationReport, idsLocale - user's work"
 *
 * Those three are the user's work and are therefore absent from `owns` — this
 * slice is not willing to destroy them on a file swap. So are the workspace
 * preferences (`idsDisplayOptions`, `idsFilterMode`, `idsFocusMode`) and the
 * report-derived caches (`idsAuditReport`, `idsAuditing`, `idsIsolationScope`,
 * `idsIsolateMode`, `idsFailedEntityIds`, `idsPassedEntityIds`), none of which
 * `resetViewerState` touches: they belong to the report, and the report
 * survives.
 *
 * `clearIdsValidationReport()` — which `removeModel` and `clearAllModels` do
 * call — stays an ENTRY-POINT side effect and is not folded in here. It
 * observes a load-bearing order internally (`endIdsRowFocus` RELEASES the
 * shared isolate/ghost channels before the `set` nulls the record), and that
 * order is not expressible in a pure patch.
 */
export const idsTeardown = defineSliceTeardown(
  'idsSlice',
  [
    'idsPanelVisible',
    'idsLoading',
    'idsProgress',
    'idsError',
    'idsActiveSpecificationId',
    'idsActiveEntityId',
    'idsFocusVisibilityOwned',
  ],
  {
    'session-reset': () => ({
      idsPanelVisible: false,
      idsLoading: false,
      idsProgress: null,
      idsError: null,
      idsActiveSpecificationId: null,
      idsActiveEntityId: null,
      // The per-row focus's claim on the shared isolate/ghost channels
      // (#2867) goes with the row it belonged to. Both channels are nulled
      // by the same `set` this patch is applied through, so there is
      // nothing left to release — but the RECORD must not survive:
      // ownership is tested by value, so a record left behind starts
      // matching again the moment another owner installs equal content,
      // and the next release destroys that owner's presentation (#2654
      // fourth review).
      idsFocusVisibilityOwned: null,
    }),
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);
