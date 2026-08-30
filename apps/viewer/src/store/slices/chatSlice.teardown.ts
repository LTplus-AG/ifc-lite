/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The chat slice's contribution to viewer-state teardown.
 *
 * A sibling module rather than a block at the bottom of `chatSlice.ts` because
 * that file sits at its recorded module-size budget (452 lines,
 * `scripts/module-size-allowlist.txt`), which a raise could lift but a
 * split does not need.
 */

import { defineSliceTeardown, notApplicable } from '../teardown.js';

/**
 * What a session reset clears on the chat slice.
 *
 * Carried verbatim from `resetViewerState` (`store/index.ts`):
 *   "Chat - keep messages and panel visible, reset streaming state"
 *
 * The transcript is the user's conversation and survives a file swap, so
 * `chatMessages` and `chatPanelVisible` are absent from `owns` — as are the
 * workspace settings (`chatActiveModel`, `chatAutoExecute`) and the compose-box
 * contents (`chatAttachments`, `chatPendingPrompt`, `chatPendingRepairRequest`,
 * `chatViewportScreenshot`), none of which `resetViewerState` touches.
 *
 * `clearChatMessages()` is NOT folded in: it empties the transcript, and it
 * ABORTS the in-flight request first (see the note on `chatAbortController`
 * below).
 */
export const chatTeardown = defineSliceTeardown(
  'chatSlice',
  ['chatStatus', 'chatStreamingContent', 'chatError', 'chatAbortController'],
  {
    'session-reset': () => ({
      chatStatus: 'idle' as const,
      chatStreamingContent: '',
      chatError: null,
      // Dropped WITHOUT calling `.abort()` — that is exactly what
      // `resetViewerState` does today, and `clearChatMessages` is the
      // only path that aborts. Adding an `abort()` here would be a
      // behaviour change, and a side effect a teardown may not have.
      chatAbortController: null,
    }),
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);
