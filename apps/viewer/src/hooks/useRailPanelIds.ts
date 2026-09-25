/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The panels the rail offers, in the user's order: the desktop activity bar
 * and the mobile Panels sheet (#5853) list exactly these, so the two surfaces
 * cannot drift apart.
 *
 * Hidden panels are removed in every mode (#1263), except Properties, the
 * right pane's fallback. The collab Room panel only surfaces while the collab
 * feature flag is on, and Point Clouds (#5507) only while a point cloud asset
 * is loaded.
 */

import { useMemo } from 'react';
import { useViewerStore } from '@/store';
import { isCollabEnabled } from '@/lib/collab/config';
import type { WorkspacePanelId } from '@/lib/panels/registry';

export function useRailPanelIds(): WorkspacePanelId[] {
  const order = useViewerStore((s) => s.sidebarOrder);
  const hiddenIds = useViewerStore((s) => s.sidebarHiddenIds);
  const pointCloudAssetCount = useViewerStore((s) => s.pointCloudAssetCount);
  return useMemo(() => {
    const hidden = new Set(hiddenIds);
    return order.filter(
      (id) =>
        (!hidden.has(id) || id === 'properties') &&
        (id !== 'collab' || isCollabEnabled()) &&
        (id !== 'pointclouds' || pointCloudAssetCount > 0),
    );
  }, [order, hiddenIds, pointCloudAssetCount]);
}
