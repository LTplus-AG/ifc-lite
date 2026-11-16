/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A group row's explicit Isolate / X-ray context actions (#6368). A plain row
 * click only selects; these are the only way the list writes the shared
 * visibility channels, and each write records the list's ownership claim
 * (`lib/lists/list-visibility.ts`).
 *
 * An action is a toggle: running the one already shown for a row releases it.
 * The claim is released when the table unmounts (panel closed, list switched),
 * as Charts does, and only if the channel still shows what the list installed.
 */

import { useEffect } from 'react';
import type { ListRow } from '@ifc-lite/lists';
import { useViewerStore } from '@/store';
import type { VisibilityChannel } from '@/lib/visibility/ownership';
import { activeListRowChannel, presentListRows, releaseListVisibility } from '@/lib/lists/list-visibility';
export interface ListVisibilityActions {
  activeChannel: (key: string) => VisibilityChannel | null;
  run: (key: string, rows: readonly ListRow[], channel: VisibilityChannel) => void;
}
export function useListVisibilityActions(): ListVisibilityActions {
  useViewerStore(s => s.listVisibilityOwned);
  useViewerStore(s => s.isolatedEntities);
  useViewerStore(s => s.ghostExceptEntities);
  useEffect(() => () => releaseListVisibility(), []);
  return { activeChannel: activeListRowChannel, run: presentListRows };
}
