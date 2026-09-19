/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

interface NestMembership {
  relatingId?: number;
}

/** Refuse a proposed parent→child edge when the child is already an ancestor. */
export function assertNoNestingCycle(
  parentId: number,
  childIds: readonly number[],
  existingByChild: ReadonlyMap<number, readonly NestMembership[]>,
): void {
  const requested = new Set(childIds);
  const visited = new Set<number>();
  const ancestors = [parentId];
  while (ancestors.length > 0) {
    const current = ancestors.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const membership of existingByChild.get(current) ?? []) {
      if (membership.relatingId === undefined) continue;
      if (requested.has(membership.relatingId)) {
        throw new Error(
          `nestCostItems: parentId #${parentId} is already a descendant of childId #${membership.relatingId} `
          + 'in the existing nesting hierarchy — nesting it here would create a cycle.',
        );
      }
      ancestors.push(membership.relatingId);
    }
  }
}
