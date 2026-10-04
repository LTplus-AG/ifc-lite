/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';

/**
 * The IFC class of a renderer (global) id, from its model's data store.
 *
 * Walk collision asks this per entity rather than reading `MeshData.ifcType`,
 * which GPU-instanced occurrences and colour-merged extracts do not carry: a
 * door that loaded as an instance would otherwise be a solid wall.
 */
export function viewerEntityType(globalId: number): string | undefined {
  const state = useViewerStore.getState();
  const ref = resolveEntityRef(globalId);
  const dataStore = ref.modelId === 'legacy' ? state.ifcDataStore : state.models.get(ref.modelId)?.ifcDataStore;
  return dataStore?.entities.getTypeName(ref.expressId) || undefined;
}
