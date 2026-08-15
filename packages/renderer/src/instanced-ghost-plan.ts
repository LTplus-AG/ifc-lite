/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Deciding which instanced occurrences should be faded, separately from doing
 * it.
 *
 * The write side has to live in `Scene` — it owns the instance buffers — but
 * the decision does not, and the decision is where the bugs were: a membership
 * diff that could not see an override being dropped, a shard streaming in, or
 * the alpha changing (#2606 review). Pulled out here so it can be tested as a
 * function rather than through a GPU-shaped mock, and so `scene.ts` grows by a
 * call rather than by another stateful subsystem.
 */

export interface InstancedGhostInputs {
  /** Everything NOT in this set fades. `null`/`undefined` means no X-Ray. */
  ghostExceptIds: ReadonlySet<number> | null | undefined;
  /** Exempt from fading, matching the flat path. */
  selectedIds: ReadonlySet<number> | null | undefined;
  /** Every instanced express id currently in the scene. */
  instancedIds: Iterable<number>;
  /** The ids faded right now. */
  current: ReadonlySet<number>;
  /** Requested alpha, and the alpha the current fade was written with. */
  ghostAlpha: number;
  lastGhostAlpha: number;
  /**
   * Something other than the ghost set changed the instance colour bytes — a
   * shard landing, an override applied or dropped. The membership diff cannot
   * see those, so they force a full re-apply.
   */
  dirty: boolean;
}

export interface InstancedGhostPlan {
  /** The ids that should be faded after this pass. */
  next: Set<number>;
  /** Ids to write the fade onto. */
  toFade: number[];
  /** Ids to put back — to their override if one is active, else their own colour. */
  toRestore: number[];
  /** False when there is provably nothing to do, so the caller can return early. */
  changed: boolean;
}

/**
 * Note the asymmetry in `toFade`: an unchanged membership with `dirty` or a new
 * alpha re-fades EVERYTHING still ghosted, not just newly ghosted ids, because
 * the bytes underneath may have been overwritten since they were last set.
 */
export function planInstancedGhosting(input: InstancedGhostInputs): InstancedGhostPlan {
  const { ghostExceptIds, selectedIds, instancedIds, current, ghostAlpha, lastGhostAlpha, dirty } = input;

  const next = new Set<number>();
  if (ghostExceptIds != null) {
    for (const eid of instancedIds) {
      if (!ghostExceptIds.has(eid) && !selectedIds?.has(eid)) next.add(eid);
    }
  }

  const alphaChanged = next.size > 0 && ghostAlpha !== lastGhostAlpha;
  const forced = dirty || alphaChanged;

  if (!forced && next.size === current.size) {
    let same = true;
    for (const eid of next) {
      if (!current.has(eid)) { same = false; break; }
    }
    if (same) return { next, toFade: [], toRestore: [], changed: false };
  }

  const toRestore: number[] = [];
  for (const eid of current) {
    if (!next.has(eid)) toRestore.push(eid);
  }

  const toFade: number[] = [];
  for (const eid of next) {
    if (forced || !current.has(eid)) toFade.push(eid);
  }

  return { next, toFade, toRestore, changed: true };
}
