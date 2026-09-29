/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import type { VisibilityChannel } from '@/lib/visibility/ownership';

/** Atomically replace the shared channel and identify IDS as its producer. */
export function installIdsFocusVisibility(channel: VisibilityChannel, ids: Set<number>): void {
  const isolate = channel === 'isolate';
  useViewerStore.setState({
    isolatedEntities: isolate ? ids : null,
    ghostExceptEntities: isolate ? null : ids,
    ...(isolate ? { hiddenEntities: new Set<number>() } : {}),
    clashVisibilityOwned: null,
    basketVisibilityOwned: null,
    chartVisibilityOwned: null,
    listVisibilityOwned: null,
    idsFocusVisibilityOwned: { channel, ids },
  });
}
