/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lens visibility ownership bookkeeping (pure helpers).
 *
 * The lens panel mirrors the active lens's computed `lensHiddenIds` into the
 * GLOBAL `hiddenEntities` channel (the renderer's hide set). That channel is
 * shared with the user's manual hides, so the lens must track exactly which
 * ids it NEWLY hid ("owned" ids) and restore only those on lens switch /
 * deactivation - never an id the user had already hidden before the lens
 * applied (that would silently wipe the manual hide), and never a blanket
 * showAll() (that would also wipe isolation / class filter / ghosting).
 *
 * Same story for rule isolation: the panel pushes a rule's matched ids into
 * the shared `isolatedEntities` channel and must only clear that channel on
 * teardown if it still holds what the lens put there - if the user (or the
 * basket) has since isolated something else, the lens just drops its claim.
 *
 * These are pure functions so the ownership rules are unit-testable without
 * React or the store; the panel applies the returned deltas via the store
 * actions and persists `nextApplied` in the lens slice (component-local state
 * would lose ownership on panel unmount/remount).
 */

/** Deltas to reconcile the global hidden channel with the active lens. */
export interface LensHiddenSyncPlan {
  /** Ids to remove from the hidden channel (previously lens-owned, no longer lens-hidden). */
  show: number[];
  /** Ids to add to the hidden channel (lens-hidden and not yet hidden). */
  hide: number[];
  /** Ids the lens owns in the hidden channel after this sync (persist these). */
  nextApplied: number[];
}

/**
 * Compute the minimal show/hide deltas to sync the active lens's hidden ids
 * into the shared hidden channel, transferring ownership correctly.
 *
 * - An id hidden by the user BEFORE the lens applied (in `hiddenEntities` but
 *   not in `applied`) is never claimed: it stays hidden after teardown.
 * - An id owned by the previous lens and also hidden by the next lens keeps
 *   ownership without a transient un-hide (it appears in neither delta).
 * - Deactivation is just `lensHiddenIds = empty`: every owned id is restored.
 */
export function planLensHiddenSync(args: {
  /** Ids the lens currently owns in the hidden channel (from the lens slice). */
  applied: readonly number[];
  /** The shared hidden channel as of now (`visibilitySlice.hiddenEntities`). */
  hiddenEntities: ReadonlySet<number>;
  /** The active lens's computed hidden ids (empty set when no lens is active). */
  lensHiddenIds: ReadonlySet<number>;
}): LensHiddenSyncPlan {
  const { applied, hiddenEntities, lensHiddenIds } = args;
  const appliedSet = new Set(applied);

  const show: number[] = [];
  for (const id of appliedSet) {
    // Restore an owned id unless the new lens set still hides it (ownership
    // transfers without churn). Skip ids the user manually un-hid meanwhile.
    if (hiddenEntities.has(id) && !lensHiddenIds.has(id)) show.push(id);
  }

  const hide: number[] = [];
  const nextApplied: number[] = [];
  for (const id of lensHiddenIds) {
    // Manually hidden = hidden but not by us. Not ours to claim (and hiding
    // it again is a no-op), so it must survive lens teardown untouched.
    const manuallyHidden = hiddenEntities.has(id) && !appliedSet.has(id);
    if (manuallyHidden) continue;
    nextApplied.push(id);
    if (!hiddenEntities.has(id)) hide.push(id);
  }

  return { show, hide, nextApplied };
}

/**
 * True when the shared isolation channel still holds exactly the ids the lens
 * rule-isolation applied - i.e. the lens still owns the channel and may clear
 * it. False when isolation is off or another owner (user right-click isolate,
 * basket, BCF viewpoint) replaced it; the lens must then drop its claim
 * WITHOUT clearing, or it would wipe the other owner's isolation.
 */
export function ruleIsolationOwnsChannel(
  isolatedEntities: ReadonlySet<number> | null,
  appliedIds: readonly number[],
): boolean {
  if (isolatedEntities === null) return false;
  const appliedSet = new Set(appliedIds);
  if (isolatedEntities.size !== appliedSet.size) return false;
  for (const id of appliedSet) {
    if (!isolatedEntities.has(id)) return false;
  }
  return true;
}
