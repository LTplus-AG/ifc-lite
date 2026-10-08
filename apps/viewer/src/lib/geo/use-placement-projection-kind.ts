/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect } from 'react';
import type { ProjectedCRS } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { useProjectionKind } from './use-projection-kind';

/** Placement has one global edit session. A confirmed unavailable or angular
 * anchor cancels it, including when the previous draft belonged to a different
 * model or the source disappears and its gizmo unmounts (#7060). Pending
 * classification preserves a valid projected draft. Measurement classification
 * remains side-effect-free through useProjectionKind. */
export function usePlacementProjectionKind(crs: ProjectedCRS | undefined) {
  const kind = useProjectionKind(crs);
  const editMode = useViewerStore((s) => s.cesiumPlacementEditMode);
  const setEditMode = useViewerStore((s) => s.setCesiumPlacementEditMode);
  useEffect(() => {
    if ((kind === 'geographic' || kind === 'unresolved') && editMode) setEditMode(false);
  }, [kind, editMode, setEditMode]);
  return kind;
}
