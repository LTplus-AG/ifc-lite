/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The script slice's contribution to viewer-state teardown.
 *
 * A sibling module rather than a block at the bottom of `scriptSlice.ts`
 * because that file sits at its recorded module-size budget (536 lines,
 * `scripts/module-size-allowlist.txt`), which a raise could lift but a
 * split does not need.
 */

import { defineSliceTeardown, notApplicable } from '../teardown.js';

/**
 * What a session reset clears on the script slice.
 *
 * Carried verbatim from `resetViewerState` (`store/index.ts`):
 *   "Script - reset execution state but keep saved scripts, editor content,
 *    and panel visibility (scripts that create-and-load a model should not
 *    close the panel)"
 *
 * That parenthesis is the whole reason `scriptPanelVisible` is absent from
 * `owns`: a script is a first-class way to LOAD a model, so the load it
 * triggers must not close the panel it was run from. `savedScripts`,
 * `activeScriptId`, `scriptEditorContent`, `scriptEditorDirty`,
 * `scriptEditorSelection`, `scriptEditorRevision`, `scriptAppliedOpIds`, the
 * apply adapter, the undo/redo flags and the two monotonic counters
 * (`scriptRunSeq`, `scriptRunEpoch`) are absent for the same reason: none of
 * them is model state, and `resetViewerState` has never touched them.
 * `scriptRunEpoch` in particular is a supersession token compared across
 * hook instances — resetting it would make a stale in-flight run's captured
 * epoch match again and let it clobber a newer result.
 *
 * `resetScriptEditorForNewChat()` is NOT folded in: it clears a different,
 * wider set (the editor content, the active script, the applied-op ids) and
 * drives the editor's apply adapter, which a pure teardown may not do.
 */
export const scriptTeardown = defineSliceTeardown(
  'scriptSlice',
  [
    'scriptExecutionState',
    'scriptLastResult',
    'scriptLastError',
    'scriptLastDiagnostics',
    'scriptAssistantTurnSnapshot',
    'scriptDeleteConfirmId',
  ],
  {
    'session-reset': () => ({
      scriptExecutionState: 'idle' as const,
      // The result, the error and the diagnostics all describe a run
      // against the OUTGOING model's data store.
      scriptLastResult: null,
      scriptLastError: null,
      scriptLastDiagnostics: [],
      // The assistant's pre-turn snapshot is an undo point for an edit
      // proposed against the editor as it stood before this load.
      scriptAssistantTurnSnapshot: null,
      // A delete confirmation armed before the load is a one-shot UI
      // prompt; it must not still be pending afterwards.
      scriptDeleteConfirmId: null,
    }),
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);
