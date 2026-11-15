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
  /** Every row by express id: its parent row, and whether showing that parent brings it back. */
  readonly rows: ReadonlyMap<number, { readonly parent: number | null; readonly showsWithParent: boolean }>;
  /** Every member by express id: its row, and whether showing that row brings it back. */
  readonly members: ReadonlyMap<number, { readonly row: number; readonly showsWithRow: boolean }>;
}

/**
 * The express ids a row's eye hides or shows: the row itself, then its subtree
 * (`hide`) or the part of it that comes back with the row (`show`). Empty for
 * an id the plan has no row for.
 */
export function containerVisibilityTargets(plan: ContainerVisibilityPlan, row: number, action: 'show' | 'hide'): number[] {
  if (!plan.rows.has(row)) return [];
  const childRows = new Map<number, number[]>();
  for (const [id, { parent }] of plan.rows) {
    if (parent !== null) (childRows.get(parent) ?? childRows.set(parent, []).get(parent)!).push(id);
  }
  const included = new Set<number>();
  const pending = [row];
  while (pending.length > 0) {
    const id = pending.pop()!;
    included.add(id);
    for (const child of childRows.get(id) ?? []) {
      if (action === 'hide' || plan.rows.get(child)!.showsWithParent) pending.push(child);
    }
  }
  const targets = [...included];
  for (const [id, member] of plan.members) {
    if (included.has(member.row) && (action === 'hide' || member.showsWithRow)) targets.push(id);
  }
  return targets;
}
