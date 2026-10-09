/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { GroupInStoreParams, GroupInStorePatch, GroupRootIdentity, GroupSnapshot } from '@ifc-lite/create';
import type { EntityRef } from './types.js';

/** A current Root identity belonging to one explicit loaded source. */
export type GroupStoreIdentity = EntityRef & GroupRootIdentity;
export type GroupStoreSnapshot = GroupSnapshot & { modelId: string };
export type GroupStoreCreateParams = Omit<GroupInStoreParams, 'RelatedObjects'> & { RelatedObjects: readonly GroupStoreIdentity[] };
export type GroupStorePatch = Omit<GroupInStorePatch, 'RelatedObjects'> & { RelatedObjects: readonly GroupStoreIdentity[] };

export interface GroupStoreBackendMethods {
  readGroup?(target: GroupStoreIdentity): GroupStoreSnapshot;
  addGroup?(modelId: string, params: GroupStoreCreateParams): GroupStoreIdentity;
  updateGroup?(expected: GroupStoreSnapshot, patch: GroupStorePatch): GroupStoreIdentity;
  removeGroup?(expected: GroupStoreSnapshot): void;
}
