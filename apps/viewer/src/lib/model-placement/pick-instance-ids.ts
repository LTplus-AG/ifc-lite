/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getGlobalRenderer } from '@/lib/renderer-ref';
import { resolveEntityRef } from '@/store';

/** Snapshot resident instance IDs in the same global namespace as the raycast. */
export function repositionInstanceIds(): ReadonlyMap<string, readonly number[]> {
  const byModel = new Map<string, number[]>();
  for (const id of getGlobalRenderer()?.getScene?.()?.getInstancedEntityIds?.() ?? []) {
    const { modelId } = resolveEntityRef(id);
    let ids = byModel.get(modelId);
    if (!ids) {
      ids = [];
      byModel.set(modelId, ids);
    }
    ids.push(id);
  }
  return byModel;
}
