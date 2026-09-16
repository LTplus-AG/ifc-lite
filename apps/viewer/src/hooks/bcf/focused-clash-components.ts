/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The focused clash, as BCF "found objects" (#4806).
 *
 * `focusClash` (and single-element step-through) deliberately clears the live
 * selection and paints the clashing elements only through the clash colour
 * channel (#1277/#1339), recorded in `clashHighlightColors`. A viewpoint
 * captured from ANY entry point while a clash is focused (the Clash panel's
 * "Create BCF topic", the BCF panel's "New topic" or "Capture viewpoint")
 * would otherwise carry no selection at all. This turns that one record into
 * the selection and colouring a viewpoint should carry, so every path agrees.
 */

import { clashColorToBcfArgb, type RGBA } from '@/lib/clash/clash-colors';

export interface FocusedClashComponents {
  /** Federated global ids of the painted elements, in paint order. */
  selectedRefs: number[];
  /** The same ids grouped by their on-screen colour as BCF ARGB hex. */
  coloredRefs: { color: string; refs: number[] }[];
}

export function focusedClashComponents(
  clashHighlightColors: ReadonlyMap<number, RGBA> | null | undefined,
): FocusedClashComponents | null {
  if (!clashHighlightColors || clashHighlightColors.size === 0) return null;
  const byColor = new Map<string, number[]>();
  for (const [ref, rgba] of clashHighlightColors) {
    const color = clashColorToBcfArgb(rgba);
    const refs = byColor.get(color);
    if (refs) refs.push(ref);
    else byColor.set(color, [ref]);
  }
  return {
    selectedRefs: [...clashHighlightColors.keys()],
    coloredRefs: [...byColor].map(([color, refs]) => ({ color, refs })),
  };
}
