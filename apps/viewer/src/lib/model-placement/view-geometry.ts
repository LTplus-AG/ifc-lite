/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { GeometryResult } from '@ifc-lite/geometry';
import { resolveEntityRef, useViewerStore, type ViewerState } from '@/store';
import { displayedTranslation } from './state';
import { placedFlatGeometry } from './placed-geometry';

export function placedViewGeometry(geometry: GeometryResult, state: ViewerState = useViewerStore.getState()): GeometryResult {
  if (!state.modelPlacement.placements.size && !state.modelPlacement.preview) return geometry;
  return placedFlatGeometry(geometry, (mesh) => displayedTranslation(state.modelPlacement, resolveEntityRef(mesh.expressId).modelId), state.mutationVersion);
}
