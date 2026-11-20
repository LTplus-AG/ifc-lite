/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { stateRevision } from './state-revision';

/**
 * The manual-group library revision covers the entries and which workspace is active, because clash.drafts.create and
 * clash.groups.library act on the active one: a workspace switch by another client refuses a token read before it
 * (#10794). It also refuses clash.groups.write, which then needs a fresh read.
 */
export function groupLibraryRevision(library: { entries: unknown; activeId: string }): string {
  return stateRevision({ entries: library.entries, activeId: library.activeId });
}
