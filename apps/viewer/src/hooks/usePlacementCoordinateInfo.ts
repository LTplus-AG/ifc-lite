/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useMemo, useSyncExternalStore } from 'react';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { placementCoordinateInfo } from '@/lib/section/placement-coordinate-info';
import { getPlacementBoundsRevision, subscribePlacementBounds } from '@/lib/model-placement/bounds-revision';

/** Shared 2D/3D section extent. Preserve geographic metadata; change only the
 * placed bounds. Live bounds cover flat, instanced, textured and scan geometry.
 * Before upload, source model bounds provide the same translated fallback. */
export function usePlacementCoordinateInfo(source: CoordinateInfo | undefined): CoordinateInfo | undefined {
  const models = useViewerStore((state) => state.models);
  const placement = useViewerStore((state) => state.modelPlacement);
  const mutationVersion = useViewerStore((state) => state.mutationVersion);
  const alignmentEnabled = useViewerStore((state) => state.pointCloudAlignmentEnabled);
  const boundsRevision = useSyncExternalStore(subscribePlacementBounds, getPlacementBoundsRevision, getPlacementBoundsRevision);
  return useMemo(() => {
    return placementCoordinateInfo(source, models, placement);
  }, [source, models, placement, mutationVersion, alignmentEnabled, boundsRevision]);
}
