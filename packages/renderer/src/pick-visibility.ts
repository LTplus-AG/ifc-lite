/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hide/isolate for the colour-batch pick pass (#10264 S1).
 *
 * A colour batch holds many entities, and the per-entity pick meshes that used
 * to carry visibility are exactly what the batch pass avoids building. So the
 * pass draws each batch whole and its fragment shader asks this table whether
 * the entity behind the fragment is visible: the same rule as
 * `isEntityVisible`, evaluated on the GPU.
 *
 * Image layout (u32): `[hiddenCount, isolationActive, isolatedCount, 0,
 * hidden ids ascending..., isolated ids ascending...]`. `isolationActive`
 * keeps the distinction `isEntityVisible` documents: an EMPTY isolation set
 * hides everything, an absent one hides nothing.
 */

export const PICK_VISIBILITY_HEADER_WORDS = 4;

/** Ids the table can hold: full scene ids that fit the u32 lane, sorted ascending. */
function sortedIds(ids: ReadonlySet<number> | null | undefined): Uint32Array {
  const out = new Uint32Array(ids?.size ?? 0);
  let n = 0;
  for (const id of ids ?? []) {
    if (Number.isInteger(id) && id >= 0 && id <= 0xFFFFFFFF) out[n++] = id;
  }
  return out.subarray(0, n).sort();
}

/** Pack hide/isolate into the image the pick shader reads. */
export function pickVisibilityImage(
  hiddenIds: ReadonlySet<number> | null | undefined,
  isolatedIds: ReadonlySet<number> | null | undefined,
): Uint32Array {
  const hidden = sortedIds(hiddenIds);
  const isolated = sortedIds(isolatedIds);
  const image = new Uint32Array(PICK_VISIBILITY_HEADER_WORDS + hidden.length + isolated.length);
  image[0] = hidden.length;
  image[1] = isolatedIds != null ? 1 : 0;
  image[2] = isolated.length;
  image.set(hidden, PICK_VISIBILITY_HEADER_WORDS);
  image.set(isolated, PICK_VISIBILITY_HEADER_WORDS + hidden.length);
  return image;
}

/**
 * CPU mirror of {@link pickVisibilityWgsl}'s `pickVisible`, so the table's
 * reading is testable without a device.
 */
export function pickVisibleInImage(image: Uint32Array, id: number): boolean {
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
  if (hiddenCount > 0 && has(PICK_VISIBILITY_HEADER_WORDS, hiddenCount)) return false;
  if (image[1] !== 0) return has(PICK_VISIBILITY_HEADER_WORDS + hiddenCount, image[2] ?? 0);
  return true;
}

/** The shader half; `pickVisibility` is bound by the batch pick pass. */
export const pickVisibilityWgsl = `
fn pickSortedHas(start: u32, count: u32, id: u32) -> bool {
  var lo = 0u;
  var hi = count;
  while (lo < hi) {
    let mid = lo + (hi - lo) / 2u;
    let key = pickVisibility[start + mid];
    if (key == id) { return true; }
    if (key < id) { lo = mid + 1u; } else { hi = mid; }
  }
  return false;
}
fn pickVisible(id: u32) -> bool {
  let hiddenCount = pickVisibility[0];
  if (hiddenCount > 0u && pickSortedHas(${PICK_VISIBILITY_HEADER_WORDS}u, hiddenCount, id)) { return false; }
  if (pickVisibility[1] != 0u) { return pickSortedHas(${PICK_VISIBILITY_HEADER_WORDS}u + hiddenCount, pickVisibility[2], id); }
  return true;
}
`;

/**
 * Caches the last image: hover picks reuse the same sets many times a second,
 * and a 100K-id hide list should not be re-sorted for each. Equal size plus
 * every cached id still present means the sets are equal, so the reuse is
 * exact even if a caller mutated a set in place.
 */
export class PickVisibilityCache {
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
    this.image = pickVisibilityImage(hiddenIds, isolatedIds);
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
