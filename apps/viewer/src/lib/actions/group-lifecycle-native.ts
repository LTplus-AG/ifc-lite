/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { addGroupToStore, updateGroupInStore, removeGroupInStore, type GroupNativeEvidence, type GroupRootIdentity } from '@ifc-lite/create';
import { resolveLiveOwnerHistoryId } from '@ifc-lite/sdk';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GroupProposal } from './group-lifecycle-proposal';

export interface GroupWriteRow extends GroupRootIdentity { index: number }
/** Reuse the exact lifecycle owner for both a detached native preview and its approved commit. */
export function writeGroupOperations(dataStore: IfcDataStore, draft: StoreEditor, proposal: GroupProposal,
  captured: GroupNativeEvidence, approved: ReadonlySet<number>, guidSource: (index: number) => () => string): GroupWriteRow[] {
  const known = [...captured.members, ...captured.groups.flatMap(group => group.memberships.flatMap(row => row.RelatedObjects))];
  return proposal.operations.flatMap((operation, index) => {
    if (!approved.has(index)) return [];
    const context = { store: dataStore, mutationView: draft.getMutationView(),
      ownerHistoryId: resolveLiveOwnerHistoryId(dataStore, draft, draft.getMutationView()), guidSource: guidSource(index) };
    if (operation.op !== 'group.remove') for (const member of operation.params.RelatedObjects) {
      if (!known.some(root => root.expressId === member.expressId && root.GlobalId === member.GlobalId)) throw new Error('Group membership is outside the complete captured native population');
    }
    if (operation.op === 'group.create') return [{ index, ...addGroupToStore(context, operation.params) }];
    const expected = captured.groups.find(group => group.expressId === operation.target.expressId && group.GlobalId === operation.target.GlobalId);
    if (!expected) throw new Error('Group target is outside the captured exact generic groups');
    if (operation.op === 'group.update') return [{ index, ...updateGroupInStore(context, expected, operation.params) }];
    removeGroupInStore(context, expected);
    return [{ index, ...operation.target }];
  });
}
