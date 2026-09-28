/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { EntityRef } from '@/store/types';

/** Resolve the selected record when it exists only in the live mutation view. */
export function selectedOverlayEntity(
  selectedEntity: EntityRef | null,
  mutationViews: ReadonlyMap<string, MutablePropertyView>,
) {
  if (!selectedEntity?.expressId) return null;
  const modelId = selectedEntity.modelId === 'legacy' ? '__legacy__' : selectedEntity.modelId;
  return mutationViews.get(modelId)?.getNewEntity(selectedEntity.expressId) ?? null;
}
