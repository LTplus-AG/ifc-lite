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

import { useCallback, useEffect, useState } from 'react';
import type { ListRow } from '@ifc-lite/lists';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { ownsCurrentVisibility, type VisibilityChannel } from '@/lib/visibility/ownership';
import { presentListIds, releaseListVisibility } from '@/lib/lists/list-visibility';

export interface ListVisibilityActions {
  /** The channel the list is showing for the row with `key`, or `null`. */
  activeChannel: (key: string) => VisibilityChannel | null;
  /** Isolate / X-ray the row's members, or release that presentation if it is the one shown. */
  run: (key: string, rows: readonly ListRow[], channel: VisibilityChannel) => void;
}

export function useListVisibilityActions(): ListVisibilityActions {
  const models = useViewerStore((s) => s.models);
  const owned = useViewerStore((s) => s.listVisibilityOwned);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const ghostExceptEntities = useViewerStore((s) => s.ghostExceptEntities);
  // Which row the current claim came from; the claim itself only holds ids.
  const [shownKey, setShownKey] = useState<string | null>(null);

  const activeChannel = useCallback((key: string): VisibilityChannel | null => {
    if (key !== shownKey || !owned) return null;
    return ownsCurrentVisibility({ isolatedEntities, ghostExceptEntities }, owned) ? owned.channel : null;
  }, [shownKey, owned, isolatedEntities, ghostExceptEntities]);

  const run = useCallback((key: string, rows: readonly ListRow[], channel: VisibilityChannel) => {
    if (activeChannel(key) === channel) {
      releaseListVisibility();
      setShownKey(null);
      return;
    }
    const ids = rows.map((row) => toGlobalIdFromModels(models, row.modelId, row.entityId));
    if (ids.length === 0) return;
    presentListIds(ids, channel);
    setShownKey(key);
  }, [activeChannel, models]);

  useEffect(() => () => releaseListVisibility(), []);

  return { activeChannel, run };
}
