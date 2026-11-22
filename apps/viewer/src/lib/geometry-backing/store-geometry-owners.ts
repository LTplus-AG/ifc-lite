/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerState } from '@/store';

/** Canonical geometry owners, including the supported top-level legacy store. */
export function storeGeometryOwners(state: Pick<ViewerState, 'models' | 'geometryResult'>) {
  if (state.models.size > 0) return [...state.models].map(([modelId, model]) => ({ modelId, geometryResult: model.geometryResult }));
  return state.geometryResult ? [{ modelId: '__legacy__', geometryResult: state.geometryResult }] : [];
}
