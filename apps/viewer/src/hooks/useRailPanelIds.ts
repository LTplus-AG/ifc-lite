/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The panels the rail offers, in the user's order: the desktop activity bar
 * and the mobile Panels sheet (#5853) list exactly these, so the two surfaces
 * cannot drift apart.
 *
 * Hidden panels are removed in every mode (#1263), except Properties, the
 * right pane's fallback. The collaboration panel only surfaces while that
 * feature is enabled. Point Clouds remains reachable before loading an asset
 * and shows an empty state (#5873).
 */

import { useMemo } from 'react';
import { useViewerStore } from '@/store';
import { isCollabEnabled } from '@/lib/collab/config';
import type { WorkspacePanelId } from '@/lib/panels/registry';

export function useRailPanelIds(): WorkspacePanelId[] {
  const order = useViewerStore((s) => s.sidebarOrder);
  const hiddenIds = useViewerStore((s) => s.sidebarHiddenIds);
  return useMemo(() => {
    const hidden = new Set(hiddenIds);
    return order.filter(
      (id) =>
        (!hidden.has(id) || id === 'properties') &&
        (id !== 'collab' || isCollabEnabled()),
    );
  }, [order, hiddenIds]);
}
