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
  /**
   * Rows and members whose own state is off, so a parent's Show leaves them
   * (and, for a row, its subtree) hidden. Only `setOwnState` changes it, in
   * place: recording a choice must not replace the model record, which would
   * rebuild the whole tree on every click.
   */
  readonly ownOff: ReadonlySet<number>;
  /** Rows that are also an object of their own whose own state is off: the row's eye is the layer's, so it never shows that object. */
  readonly selfOff: ReadonlySet<number>;
}

const revisions = new WeakMap<ContainerVisibilityPlan, number>();

/** Bumped by every `setOwnState` that changes something, so a cache of targets knows to start afresh. */
export function ownStateRevision(plan: ContainerVisibilityPlan): number {
  return revisions.get(plan) ?? 0;
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
    if (action === 'hide' || !plan.selfOff.has(id)) targets.push(id);
    const { children, members } = plan.rows.get(id)!;
    for (const child of children) if (comesBack(child)) pending.push(child);
    for (const member of members) if (comesBack(member)) targets.push(member);
  }
  return targets;
}

/** Record that the user turned `id`'s own state on or off from the tree. */
export function setOwnState(plan: ContainerVisibilityPlan, id: number, on: boolean): void {
  // The plan's sets are read-only to everyone else, so the revision cannot be skipped.
  const ownOff = plan.ownOff as Set<number>;
  let changed: boolean;
  if (on) {
    changed = ownOff.delete(id);
  } else {
    changed = !ownOff.has(id);
    ownOff.add(id);
  }
  if (changed) revisions.set(plan, ownStateRevision(plan) + 1);
}
