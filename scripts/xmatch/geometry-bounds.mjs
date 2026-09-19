/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Mirrors the engine's unexported `POSITION_EXTENT_RATIO`. */
const POSITION_EXTENT_RATIO = 2;

/** Stable key for excluding one recipient/map pairing on a regeneration. */
export function donorPairKey(productId, mapId) {
  return `${productId}:${mapId}`;
}

/** Per-axis extents within the same ratio the `position` successor stage accepts. */
export function sizesComparable(a, b) {
  if (!a || !b) return false;
  for (let axis = 0; axis < 3; axis++) {
    const ea = a.max?.[axis] - a.min?.[axis];
    const eb = b.max?.[axis] - b.min?.[axis];
    if (!Number.isFinite(ea) || !Number.isFinite(eb)) return false;
    const big = Math.max(ea, eb);
    const small = Math.min(ea, eb);
    // Two flat extents agree; one flat against one not does not.
    if (big <= 0) continue;
    if (small <= 0 || big / small > POSITION_EXTENT_RATIO) return false;
  }
  return true;
}

/**
 * Swaps that the canonical geometry pass proves cannot enter the engine's
 * `position` successor stage. This is the definitive check after mutation:
 * it sees profile dimensions, mapped-item transforms and product placements,
 * rather than trying to infer geometry from STEP point records.
 */
export function incomparableSwaps(key, baseFingerprints, headFingerprints) {
  const baseById = new Map(baseFingerprints.map((fingerprint) => [fingerprint.ref, fingerprint]));
  const headById = new Map(headFingerprints.map((fingerprint) => [fingerprint.ref, fingerprint]));
  const failures = [];
  for (const element of key.elements) {
    if (element.kind !== 'swapped') continue;
    const donorMap = element.detail?.donorMap;
    const headId = element.head.length === 1 ? element.head[0] : undefined;
    const base = baseById.get(element.base);
    const head = headId === undefined ? undefined : headById.get(headId);
    if (!Number.isInteger(donorMap) || !sizesComparable(base?.aabb, head?.aabb)) {
      failures.push({ base: element.base, donorMap, head: headId });
    }
  }
  return failures;
}
