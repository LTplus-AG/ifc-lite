/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Opening the storey manager (#9013): eager and tiny, so the chip and plan header need no storey write path. */

import type { ViewerState } from '@/store';

/** Show the storey manager in the Model inspector. */
export function openStoreyManager(s: Pick<ViewerState, 'setStoreyManagerOpen' | 'showWorkspacePanel' | 'sidebarActivePanel'>): void {
  s.setStoreyManagerOpen(true);
  if (s.sidebarActivePanel !== 'model') s.showWorkspacePanel('model');
}
