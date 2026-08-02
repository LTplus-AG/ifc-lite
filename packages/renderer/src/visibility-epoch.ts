/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Content-based change tracking for the per-frame hide/isolate sets.
 *
 * The renderer caches per-batch visibility keyed by the version this tracker
 * produces, so correctness demands the version bumps EXACTLY when the
 * effective filter changes:
 * - Callers may mutate the SAME Set object in place between frames (the
 *   per-mesh filters read the live set every frame, so a reference-compare
 *   epoch would silently diverge from them) — content comparison against a
 *   snapshot catches this.
 * - Callers may pass a FRESH Set with identical content every frame (zustand
 *   slices rebuild the Set on every action) — content comparison avoids a
 *   needless cache rebuild that a reference compare would force.
 */
export class VisibilityEpochTracker {
  private version = 0;
  // Snapshots (copies) of the last-seen effective sets. Copies, not the
  // caller's references — an in-place mutation of the caller's Set must
  // compare against what we saw LAST frame, not against itself.
  private hiddenSnapshot: ReadonlySet<number> | null = null;
  private isolatedSnapshot: ReadonlySet<number> | null = null;

  /**
   * Feed the sets passed to render(); returns the current version, bumped when
   * the content changed since the previous call. An EMPTY hidden set is
   * equivalent to no hidden filter; an EMPTY isolated set is NOT equivalent to
   * null (it isolates nothing, i.e. hides everything). Cost is
   * O(|hidden| + |isolated|) membership checks per call — strictly below the
   * O(scene elements) per-batch scan this version key lets the renderer skip.
   */
  update(
    hiddenIds: ReadonlySet<number> | null | undefined,
    isolatedIds: ReadonlySet<number> | null | undefined,
  ): number {
    const hidden = hiddenIds && hiddenIds.size > 0 ? hiddenIds : null;
    const isolated = isolatedIds ?? null;
    const hiddenChanged = !contentEquals(hidden, this.hiddenSnapshot);
    const isolatedChanged = !contentEquals(isolated, this.isolatedSnapshot);
    if (hiddenChanged || isolatedChanged) {
      this.version++;
      if (hiddenChanged) this.hiddenSnapshot = hidden ? new Set(hidden) : null;
      if (isolatedChanged) this.isolatedSnapshot = isolated ? new Set(isolated) : null;
    }
    return this.version;
  }

  getVersion(): number {
    return this.version;
  }
}

function contentEquals(
  live: ReadonlySet<number> | null,
  snapshot: ReadonlySet<number> | null,
): boolean {
  if (live === snapshot) return true; // covers null === null
  if (live === null || snapshot === null) return false;
  if (live.size !== snapshot.size) return false;
  for (const id of live) {
    if (!snapshot.has(id)) return false;
  }
  return true;
}
