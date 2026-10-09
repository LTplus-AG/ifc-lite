/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { addGroupToStore, updateGroupInStore, removeGroupInStore, readGroupInStore, type GroupRootIdentity } from '@ifc-lite/create';
import type { CostStoreModelResolver } from './cost-store-backend.js';
import type { GroupStoreBackendMethods, GroupStoreIdentity, GroupStoreSnapshot } from './store-group-types.js';

/** Hosts resolve their current source; all graph ownership remains native. */
export function createGroupStoreBackend(resolve: CostStoreModelResolver): Required<GroupStoreBackendMethods> {
  function source(modelId: string) {
    if (!modelId) throw new Error('Group requires an explicit loaded model');
    const current = resolve(modelId);
    if (current.modelId !== modelId) throw new Error('Group source ownership changed');
    return current;
  }
  function members(modelId: string, values: readonly GroupStoreIdentity[]): GroupRootIdentity[] {
    if (!Array.isArray(values)) throw new Error('Group requires complete explicit RelatedObjects');
    return values.map(value => {
      if (value.modelId !== modelId) throw new Error('Group cannot assign a member from another source');
      return { expressId: value.expressId, GlobalId: value.GlobalId };
    });
  }
  function nativeSnapshot(expected: GroupStoreSnapshot) {
    const { modelId: _modelId, ...snapshot } = expected;
    return snapshot;
  }
  return {
    readGroup(target) {
      return { ...readGroupInStore(source(target.modelId), target), modelId: target.modelId };
    },
    addGroup(modelId, params) {
      const current = source(modelId);
      return { ...addGroupToStore(current, { ...params, RelatedObjects: members(modelId, params.RelatedObjects) }), modelId };
    },
    updateGroup(expected, patch) {
      const current = source(expected.modelId);
      return { ...updateGroupInStore(current, nativeSnapshot(expected), { ...patch, RelatedObjects: members(expected.modelId, patch.RelatedObjects) }), modelId: expected.modelId };
    },
    removeGroup(expected) { removeGroupInStore(source(expected.modelId), nativeSnapshot(expected)); },
  };
}
