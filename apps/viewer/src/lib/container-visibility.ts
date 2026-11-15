/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How a source file's container rows hide and show what is nested in them,
 * when the source says so (a Rhino layer, #10214). Without a plan, a row's eye
 * acts on what the row holds directly, as for IFC.
 *
 * Hiding a row hides its whole subtree. Showing it brings back what the source
 * would show once that row is on: each nested row and member whose own state
 * lets it come back with its parent. Ids are model-local express ids.
 */
export interface ContainerVisibilityPlan {
  /** Every row by express id: its child rows and members, and whether each comes back when this row is shown. */
  readonly rows: ReadonlyMap<number, ContainerVisibilityRow>;
}

export interface ContainerVisibilityRow {
  readonly children: readonly { readonly id: number; readonly showsWithParent: boolean }[];
  readonly members: readonly { readonly id: number; readonly showsWithRow: boolean }[];
}

/**
 * The express ids a row's eye hides or shows: the row itself, then its subtree
 * (`hide`) or the part of it that comes back with the row (`show`). Empty for
 * an id the plan has no row for.
 */
export function containerVisibilityTargets(plan: ContainerVisibilityPlan, row: number, action: 'show' | 'hide'): number[] {
  if (!plan.rows.has(row)) return [];
  const targets: number[] = [];
  const pending = [row];
  while (pending.length > 0) {
    const id = pending.pop()!;
    targets.push(id);
    const { children, members } = plan.rows.get(id)!;
    for (const child of children) if (action === 'hide' || child.showsWithParent) pending.push(child.id);
    for (const member of members) if (action === 'hide' || member.showsWithRow) targets.push(member.id);
  }
  return targets;
}
