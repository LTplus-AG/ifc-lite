/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CostRemovalReferrers } from '@ifc-lite/create';

export function knownReferrerIds(referrers: CostRemovalReferrers): Set<number> {
  return new Set([
    ...(referrers.itemCostValues?.keys() ?? []),
    ...(referrers.valueComponents?.keys() ?? []),
    ...(referrers.valueAppliedValueRef?.keys() ?? []),
    ...(referrers.nestRelatedObjects?.keys() ?? []),
    ...(referrers.assignmentRelatedObjects?.keys() ?? []),
    ...(referrers.nestsAsParent ?? []),
    ...(referrers.assignmentsAsControl ?? []),
    ...(referrers.otherRelationshipLists ?? []).map(ref => ref.relId),
    ...(referrers.otherRelationships ?? []),
  ]);
}

export function knownReferenceCount(
  referrers: CostRemovalReferrers,
  targetId: number,
  referrerId: number,
): number {
  const count = (values: readonly number[] | undefined) =>
    values?.filter(id => id === targetId).length ?? 0;
  let total = count(referrers.itemCostValues?.get(referrerId));
  total += count(referrers.valueComponents?.get(referrerId));
  if (referrers.valueAppliedValueRef?.get(referrerId) === targetId) total++;
  total += count(referrers.nestRelatedObjects?.get(referrerId));
  total += count(referrers.assignmentRelatedObjects?.get(referrerId));
  for (const ref of referrers.otherRelationshipLists ?? []) {
    if (ref.relId === referrerId) total += count(ref.relatedIds);
  }
  if ((referrers.nestsAsParent ?? []).includes(referrerId)) total++;
  if ((referrers.assignmentsAsControl ?? []).includes(referrerId)) total++;
  if ((referrers.otherRelationships ?? []).includes(referrerId)) total++;
  return total;
}
