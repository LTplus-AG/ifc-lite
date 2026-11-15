/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How a source file's container rows hide and show what is nested in them,
 * when the source says so (a Rhino layer, #10214). Without a plan, a row's eye
 * acts on what the row holds directly, as for IFC.
 *
 * Each row and member has an own state, as a Rhino layer and object do.
 * Hiding a row hides its whole subtree. Showing it brings back each nested row
 * and member whose own state is on, under rows that come back. Toggling a row
 * or member from the tree sets its own state, so a later toggle of its parent
 * respects it. Ids are model-local express ids.
 */
export interface ContainerVisibilityPlan {
  /** Every row by express id: the rows and members it holds directly. */
  readonly rows: ReadonlyMap<number, { readonly children: readonly number[]; readonly members: readonly number[] }>;
  /** Rows and members whose own state is off, so a parent's Show leaves them hidden. */
  readonly ownOff: ReadonlySet<number>;
}

/**
 * The express ids a row's eye hides or shows: the row itself, then its subtree
 * (`hide`) or the part of it whose own state is on (`show`). Empty for an id
 * the plan has no row for.
 */
export function containerVisibilityTargets(plan: ContainerVisibilityPlan, row: number, action: 'show' | 'hide'): number[] {
  if (!plan.rows.has(row)) return [];
  const comesBack = (id: number) => action === 'hide' || !plan.ownOff.has(id);
  const targets: number[] = [];
  const pending = [row];
  while (pending.length > 0) {
    const id = pending.pop()!;
    targets.push(id);
    const { children, members } = plan.rows.get(id)!;
    for (const child of children) if (comesBack(child)) pending.push(child);
    for (const member of members) if (comesBack(member)) targets.push(member);
  }
  return targets;
}

/** The plan after the user turned `id`'s own state on or off from the tree; the same plan when it already was. */
export function withOwnState(plan: ContainerVisibilityPlan, id: number, on: boolean): ContainerVisibilityPlan {
  if (plan.ownOff.has(id) !== on) return plan;
  const ownOff = new Set(plan.ownOff);
  if (on) ownOff.delete(id);
  else ownOff.add(id);
  return { rows: plan.rows, ownOff };
}
