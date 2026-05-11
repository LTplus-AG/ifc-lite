/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Deterministic per-user color helper.
 *
 * Spec §7: "Each user has a stable color hash from their user ID." Two
 * users with the same id always get the same color across sessions and
 * across machines so cursors / selection outlines stay consistent in the
 * viewer.
 *
 * The palette is curated for ~12 distinguishable hues that read well in
 * both light and dark themes. We hash the id with FNV-1a (32-bit) — fast,
 * dependency-free, and collision properties are good enough for a
 * 12-bucket pick.
 */

/**
 * Default palette of distinguishable hex colors used by the viewer for
 * peer cursors and selection outlines.
 */
export const DEFAULT_USER_PALETTE: readonly string[] = [
  '#5b8def', // blue
  '#ef6f6c', // red
  '#7ac74f', // green
  '#f5b041', // amber
  '#a569bd', // purple
  '#48c9b0', // teal
  '#ec7063', // coral
  '#5d6d7e', // slate
  '#f4d03f', // gold
  '#ec407a', // pink
  '#26a69a', // jade
  '#7e57c2', // violet
] as const;

/**
 * 32-bit FNV-1a hash of a string. Stable, dependency-free.
 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime: 16777619
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Pick a deterministic color from `palette` for the given user id.
 *
 * Same id + same palette → same color, always. Different palettes pick
 * different colors for the same id, which is what consumers want when
 * they bring their own brand palette.
 */
export function colorForUser(
  userId: string,
  palette: readonly string[] = DEFAULT_USER_PALETTE,
): string {
  if (palette.length === 0) {
    throw new Error('@ifc-lite/collab: colorForUser requires a non-empty palette');
  }
  const idx = fnv1a(userId) % palette.length;
  return palette[idx];
}
