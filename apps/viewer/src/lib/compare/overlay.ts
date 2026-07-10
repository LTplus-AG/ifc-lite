/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure mapping from a model-diff to the renderer's colour + visibility
 * channels (issue #924). Kept side-effect-free so it can be unit-tested in
 * isolation; the `useCompareOverlay` hook wires the result into the store.
 *
 * Both models (A = base, B = head) are loaded in the federated scene at once,
 * so an unchanged element exists twice at the same place. We therefore drive
 * the comparison entirely from model B and suppress B-duplicated copies in
 * model A:
 *
 *   - added    (B only) → green   on B
 *   - modified (A and B) → yellow  on B, **hide** the A copy
 *   - deleted  (A only) → red     on A
 *   - unchanged          → ghost grey on B + hide A  (when "show unchanged"),
 *                          otherwise hide both
 *
 * Colours match the threejs compare example's palette. Keys are federation
 * **global** ids (`CompareRef.globalId`) — exactly what the renderer's
 * `setColorOverrides` / hidden set consume.
 */

import type { ModelDiff } from '@ifc-lite/diff';
import type { CompareRef } from './buildFingerprints';

export type RGBA = [number, number, number, number];

/** Diff-state colour conventions. `unchanged` is a translucent ghost. */
export const COMPARE_COLORS = {
  added: [0.22, 0.78, 0.44, 1] as RGBA,
  modified: [1.0, 0.6, 0.18, 1] as RGBA,
  deleted: [0.95, 0.3, 0.3, 1] as RGBA,
  unchanged: [0.45, 0.52, 0.58, 0.32] as RGBA,
} as const;

export interface CompareOverlay {
  /** Per global-id colour override fed to `scene.setColorOverrides`. */
  colorOverrides: Map<number, RGBA>;
  /** Global ids to hide (suppresses duplicated base-model geometry). */
  hiddenIds: Set<number>;
}

/**
 * Build the colour + hidden maps for a comparison.
 *
 * @param diff           engine output (refs carry the federation global id)
 * @param showUnchanged  draw unchanged elements ghosted (true) or hide them
 * @param excludedHiddenIds  federation global ids of blacklisted-class entities
 *   (#1470). They're absent from `diff.entries` (dropped by the engine), so they
 *   would otherwise stay drawn at full colour amid the ghosted scene - hide them
 *   so "not considered" also means "out of the way" in 3D.
 */
export function buildCompareOverlay(
  diff: ModelDiff<CompareRef>,
  showUnchanged: boolean,
  excludedHiddenIds?: ReadonlySet<number>,
): CompareOverlay {
  const colorOverrides = new Map<number, RGBA>();
  const hiddenIds = new Set<number>(excludedHiddenIds);

  for (const entry of diff.entries) {
    const baseGlobal = entry.base?.ref.globalId;
    const headGlobal = entry.head?.ref.globalId;

    switch (entry.state) {
      case 'added':
        if (headGlobal !== undefined) colorOverrides.set(headGlobal, COMPARE_COLORS.added);
        break;

      case 'deleted':
        if (baseGlobal !== undefined) colorOverrides.set(baseGlobal, COMPARE_COLORS.deleted);
        break;

      case 'modified':
        if (headGlobal !== undefined) colorOverrides.set(headGlobal, COMPARE_COLORS.modified);
        // Hide the old (base) copy so the yellow head reads cleanly.
        if (baseGlobal !== undefined) hiddenIds.add(baseGlobal);
        break;

      case 'unchanged':
        if (showUnchanged) {
          if (headGlobal !== undefined) colorOverrides.set(headGlobal, COMPARE_COLORS.unchanged);
          if (baseGlobal !== undefined) hiddenIds.add(baseGlobal);
        } else {
          if (headGlobal !== undefined) hiddenIds.add(headGlobal);
          if (baseGlobal !== undefined) hiddenIds.add(baseGlobal);
        }
        break;
    }
  }

  return { colorOverrides, hiddenIds };
}
