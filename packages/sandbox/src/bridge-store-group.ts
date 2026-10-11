/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MethodSchema } from './bridge-schema.js';
import type { GroupStoreIdentity, GroupStoreCreateParams, GroupStorePatch, GroupStoreSnapshot } from '@ifc-lite/sdk';

/** Source/Root-pinned native lifecycle; RelatedObjects always replaces the complete membership. */
export function buildStoreGroupMethods(): MethodSchema[] {
  return [
    { name: 'readGroup', doc: 'Read the current exact IfcGroup and complete membership from its loaded source.',
      args: ['dump'], paramNames: ['target'], tsParamTypes: ['BimGroup.GroupStoreIdentity'], tsReturn: 'BimGroup.GroupStoreSnapshot', returns: 'value',
      call: (sdk, args) => sdk.store.readGroup(args[0] as GroupStoreIdentity) },
    { name: 'addGroup', doc: 'Create an exact IfcGroup with explicit source-pinned RelatedObjects in one native edit.',
      args: ['string', 'dump'], paramNames: ['modelId', 'params'], tsParamTypes: ['string', 'BimGroup.GroupStoreCreateParams'], tsReturn: 'BimGroup.GroupStoreIdentity', returns: 'value',
      call: (sdk, args) => sdk.store.addGroup(args[0] as string, args[1] as GroupStoreCreateParams) },
    { name: 'updateGroup', doc: 'Preserve current group identity and replace its entire membership after verifying a complete current snapshot.',
      args: ['dump', 'dump'], paramNames: ['expected', 'patch'], tsParamTypes: ['BimGroup.GroupStoreSnapshot', 'BimGroup.GroupStorePatch'], tsReturn: 'BimGroup.GroupStoreIdentity', returns: 'value',
      call: (sdk, args) => sdk.store.updateGroup(args[0] as GroupStoreSnapshot, args[1] as GroupStorePatch) },
    { name: 'removeGroup', doc: 'Remove an exact IfcGroup and its membership edges while preserving members; protected dependencies refuse the edit.',
      args: ['dump'], paramNames: ['expected'], tsParamTypes: ['BimGroup.GroupStoreSnapshot'], returns: 'void',
      call: (sdk, args) => sdk.store.removeGroup(args[0] as GroupStoreSnapshot) },
  ];
}
