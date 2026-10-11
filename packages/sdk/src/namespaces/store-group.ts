/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { StoreModellingNamespace } from './store-modelling.js';
import type { GroupStoreCreateParams, GroupStoreIdentity, GroupStorePatch, GroupStoreSnapshot } from '../store-group-types.js';

export class StoreGroupNamespace extends StoreModellingNamespace {
  readGroup(target: GroupStoreIdentity): GroupStoreSnapshot {
    const method = this.backend.store.readGroup;
    if (!method) throw new Error('bim.store.readGroup: native Group capability is unavailable');
    return method.call(this.backend.store, target);
  }
  addGroup(modelId: string, params: GroupStoreCreateParams): GroupStoreIdentity {
    const method = this.backend.store.addGroup;
    if (!method) throw new Error('bim.store.addGroup: native Group capability is unavailable');
    return method.call(this.backend.store, modelId, params);
  }
  updateGroup(expected: GroupStoreSnapshot, patch: GroupStorePatch): GroupStoreIdentity {
    const method = this.backend.store.updateGroup;
    if (!method) throw new Error('bim.store.updateGroup: native Group capability is unavailable');
    return method.call(this.backend.store, expected, patch);
  }
  removeGroup(expected: GroupStoreSnapshot): void {
    const method = this.backend.store.removeGroup;
    if (!method) throw new Error('bim.store.removeGroup: native Group capability is unavailable');
    method.call(this.backend.store, expected);
  }
}
