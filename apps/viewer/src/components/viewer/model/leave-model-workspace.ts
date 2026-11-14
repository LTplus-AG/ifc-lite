/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';

/**
 * Leave from a control that unmounts with the workspace (the rail's, the
 * bar's and the palette's Leave): focus moves to the tab-row Model button,
 * not to <body> (#9296).
 */
export function leaveModelWorkspace(): void {
  useViewerStore.getState().exitModelWorkspace();
  document.querySelector<HTMLElement>('[data-command-id="tool:edit-mode"]')?.focus();
}
