/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hide/isolate as a GPU table (#10264 S1 picking, S2 drawing).
 *
 * A colour batch holds many entities. Instead of cutting a sub-batch of the
 * visible pieces out of the CPU copy of the geometry, a partly hidden batch is
 * drawn whole and each fragment asks this table whether the entity behind it
 * is visible: the same rule as `isEntityVisible`, evaluated on the GPU. The
 * colour pass, the shadow pass and the batch pick pass read one table per
 * device, bound beside the section exclusions (`section-exclusions.ts`).
 *
 * Image layout (u32): `[hiddenCount, isolationActive, isolatedCount, 0,
 * hidden ids ascending..., isolated ids ascending...]`. `isolationActive`
 * keeps the distinction `isEntityVisible` documents: an EMPTY isolation set
 * hides everything, an absent one hides nothing. An all-zero buffer is the
 * "nothing hidden" image.
 */

export const ENTITY_VISIBILITY_HEADER_WORDS = 4;

/**
 * Mesh uniform `flags.x` bit: this flat draw tests every fragment against the
 * table. Set only on partly visible batches, so fully visible draws keep the
 * discard-free fast path.
 */
export const MESH_FLAG_ENTITY_VISIBILITY = 64;

/** Ids the table can hold: full scene ids that fit the u32 lane, sorted ascending. */
function sortedIds(ids: ReadonlySet<number> | null | undefined): Uint32Array {
  const out = new Uint32Array(ids?.size ?? 0);
  let n = 0;
  for (const id of ids ?? []) {
    if (Number.isInteger(id) && id >= 0 && id <= 0xFFFFFFFF) out[n++] = id;
  }
  return out.subarray(0, n).sort();
}

/** Pack hide/isolate into the image the shaders read. */
export function entityVisibilityImage(
  hiddenIds: ReadonlySet<number> | null | undefined,
  isolatedIds: ReadonlySet<number> | null | undefined,
): Uint32Array {
  const hidden = sortedIds(hiddenIds);
  const isolated = sortedIds(isolatedIds);
  const image = new Uint32Array(ENTITY_VISIBILITY_HEADER_WORDS + hidden.length + isolated.length);
  image[0] = hidden.length;
  image[1] = isolatedIds != null ? 1 : 0;
  image[2] = isolated.length;
  image.set(hidden, ENTITY_VISIBILITY_HEADER_WORDS);
  image.set(isolated, ENTITY_VISIBILITY_HEADER_WORDS + hidden.length);
  return image;
}

/**
 * CPU mirror of {@link entityVisibilityWgsl}'s `entityVisible`, so the
 * table's reading is testable without a device.
 */
export function entityVisibleInImage(image: Uint32Array, id: number): boolean {
  const hiddenCount = image[0] ?? 0;
  const has = (start: number, count: number): boolean => {
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const key = image[start + mid]!;
      if (key === id) return true;
      if (key < id) lo = mid + 1; else hi = mid;
    }
    return false;
  };
  if (hiddenCount > 0 && has(ENTITY_VISIBILITY_HEADER_WORDS, hiddenCount)) return false;
  if (image[1] !== 0) return has(ENTITY_VISIBILITY_HEADER_WORDS + hiddenCount, image[2] ?? 0);
  return true;
}

/**
 * The shader half. Reads `entityVisibility`, which `sectionExclusionsWgsl`
 * declares in the shared entity-table group.
 */
export const entityVisibilityWgsl = `
fn entityVisibilityHas(start: u32, count: u32, id: u32) -> bool {
  var lo = 0u;
  var hi = count;
  while (lo < hi) {
    let mid = lo + (hi - lo) / 2u;
    let key = entityVisibility[start + mid];
    if (key == id) { return true; }
    if (key < id) { lo = mid + 1u; } else { hi = mid; }
  }
  return false;
}
fn entityVisible(id: u32) -> bool {
  let hiddenCount = entityVisibility[0];
  if (hiddenCount > 0u && entityVisibilityHas(${ENTITY_VISIBILITY_HEADER_WORDS}u, hiddenCount, id)) { return false; }
  if (entityVisibility[1] != 0u) { return entityVisibilityHas(${ENTITY_VISIBILITY_HEADER_WORDS}u + hiddenCount, entityVisibility[2], id); }
  return true;
}
`;

/**
 * Caches the last image: hover picks and frames reuse the same sets many times
 * a second, and a 100K-id hide list should not be re-sorted for each. Equal
 * size plus every cached id still present means the sets are equal, so the
 * reuse is exact even if a caller mutated a set in place.
 */
export class EntityVisibilityCache {
  private hidden: ReadonlySet<number> | null | undefined;
  private isolated: ReadonlySet<number> | null | undefined;
  private hiddenSnapshot: number[] = [];
  private isolatedSnapshot: number[] | null = null;
  private image: Uint32Array | null = null;

  /** The image for these sets: the previous array object when the sets are unchanged. */
  resolve(
    hiddenIds: ReadonlySet<number> | null | undefined,
    isolatedIds: ReadonlySet<number> | null | undefined,
  ): Uint32Array {
    if (this.image && this.matches(hiddenIds, isolatedIds)) return this.image;
    this.hidden = hiddenIds;
    this.isolated = isolatedIds;
    this.hiddenSnapshot = [...(hiddenIds ?? [])];
    this.isolatedSnapshot = isolatedIds != null ? [...isolatedIds] : null;
    this.image = entityVisibilityImage(hiddenIds, isolatedIds);
    return this.image;
  }

  private matches(
    hiddenIds: ReadonlySet<number> | null | undefined,
    isolatedIds: ReadonlySet<number> | null | undefined,
  ): boolean {
    if (hiddenIds !== this.hidden || isolatedIds !== this.isolated) return false;
    if ((hiddenIds?.size ?? 0) !== this.hiddenSnapshot.length) return false;
    if ((isolatedIds == null) !== (this.isolatedSnapshot === null)) return false;
    if (isolatedIds != null && isolatedIds.size !== this.isolatedSnapshot!.length) return false;
    return this.hiddenSnapshot.every((id) => hiddenIds!.has(id))
      && (this.isolatedSnapshot === null || this.isolatedSnapshot.every((id) => isolatedIds!.has(id)));
  }
}

/**
 * The colour frame's write into the shared table: the image is rebuilt only
 * when the renderer's visibility epoch (`VisibilityEpochTracker`, which
 * already compares set contents) moves, so an unchanged frame costs nothing.
 */
export class FrameEntityVisibility {
  private version = -1;
  private image: Uint32Array = entityVisibilityImage(null, null);
  private awaited: Promise<boolean> | null = null;

  /**
   * False when the table could not hold the image (see `writeVisibility`).
   * While a larger table is being confirmed, `onReady` runs once when it is
   * bound, so the frame that left partly hidden batches out is redrawn; a
   * rejected table requests nothing.
   */
  write(
    table: { writeVisibility(image: Uint32Array): boolean; readonly visibilityPending?: Promise<boolean> | null },
    version: number,
    hiddenIds: ReadonlySet<number> | null | undefined,
    isolatedIds: ReadonlySet<number> | null | undefined,
    onReady?: () => void,
  ): boolean {
    if (version !== this.version) {
      this.image = entityVisibilityImage(hiddenIds, isolatedIds);
      this.version = version;
    }
    if (table.writeVisibility(this.image)) return true;
    const pending = table.visibilityPending;
    if (pending && pending !== this.awaited) {
      this.awaited = pending;
      void pending.then(ready => { if (ready) onReady?.(); });
    }
    return false;
  }
}
