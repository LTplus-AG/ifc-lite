/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LOD1 config (issue #1682, phase 5). OFF BY DEFAULT. The value is the
 * projected screen size (device px) below which a batch draws its simplified
 * LOD1 index range. Read once at renderer init; benchmark A/B env:
 * VIEWER_BENCHMARK_LOD_PX.
 *
 *   globalThis.__IFC_LITE_LOD_PX = 80
 */
export function getLodScreenPx(): number | null {
  const raw = (globalThis as { __IFC_LITE_LOD_PX?: unknown }).__IFC_LITE_LOD_PX;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}
