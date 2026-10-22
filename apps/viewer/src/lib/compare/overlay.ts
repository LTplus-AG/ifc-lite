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
 *   - modified (A and B) → yellow  on B, **hide** the A copy — unless B's copy
 *                          has no geometry at all, in which case the yellow
 *                          goes on A and nothing is hidden (see the branch)
 *   - deleted  (A only) → red     on A
 *   - unchanged          → ghost grey on B + hide A  (when "show unchanged"),
 *                          otherwise hide both — same drawable-copy caveat as
 *                          `modified`
 *   - content-matched    → blue    on B, **hide** the A copy (see below) —
 *                          same drawable-copy caveat as `modified`
 *
 * Colours match the threejs compare example's palette. Keys are federation
 * **global** ids (`CompareRef.globalId`) — exactly what the renderer's
 * `setColorOverrides` / hidden set consume.
 */

import type { ModelDiff } from '@ifc-lite/diff';
import type { CompareRef } from './buildFingerprints';
import { drawableEntryRef, drawableMatchRefs } from './drawableRefs';
import { isRetiringMatch } from './contentMatches';
import { ALL_COMPARE_RESULTS, matchesCompareEntry, matchesCompareMatch, type CompareResultFilter } from './resultFilter';

export type RGBA = [number, number, number, number];

/** Diff-state colour conventions. `unchanged` is a translucent ghost;
 *  `matched` is the content-matching pass's own channel (#1891) — deliberately
 *  a different hue from added/modified/deleted, because a match is not a
 *  change the user asked about, it is the engine saying "these two are the
 *  same element under a new GlobalId". */
export const COMPARE_COLORS = {
  added: [0.22, 0.78, 0.44, 1] as RGBA,
  modified: [1.0, 0.6, 0.18, 1] as RGBA,
  deleted: [0.95, 0.3, 0.3, 1] as RGBA,
  unchanged: [0.45, 0.52, 0.58, 0.32] as RGBA,
  matched: [0.36, 0.6, 0.95, 1] as RGBA,
} as const;

/** CSS `rgba(...)` for a compare colour — the panel's swatches and icons draw
 *  from the same palette the 3D overlay does, so the legend cannot drift from
 *  the scene. */
export function rgbaCss([r, g, b, a]: RGBA): string {
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
}

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
  filter: CompareResultFilter = ALL_COMPARE_RESULTS,
): CompareOverlay {
  const colorOverrides = new Map<number, RGBA>();
  const hiddenIds = new Set<number>(excludedHiddenIds);

  for (const entry of diff.entries) {
    const baseGlobal = entry.base?.ref.globalId;
    const headGlobal = entry.head?.ref.globalId;

    if (!matchesCompareEntry(entry, filter)) {
      if (baseGlobal !== undefined) hiddenIds.add(baseGlobal);
      if (headGlobal !== undefined) hiddenIds.add(headGlobal);
      continue;
    }

    switch (entry.state) {
      case 'added':
        if (headGlobal !== undefined) colorOverrides.set(headGlobal, COMPARE_COLORS.added);
        break;

      case 'deleted':
        if (baseGlobal !== undefined) colorOverrides.set(baseGlobal, COMPARE_COLORS.deleted);
        break;

      case 'modified':
      case 'unchanged': {
        // Hide duplicated A geometry only when B is drawable. If a revision
        // removed Representation, A is the only mesh available as evidence.
        const ref = drawableEntryRef(entry);
        if (entry.state === 'modified' || showUnchanged) {
          if (ref) {
            colorOverrides.set(ref.globalId, COMPARE_COLORS[entry.state]);
            if (ref.globalId === headGlobal && baseGlobal !== undefined) hiddenIds.add(baseGlobal);
          }
        } else {
          if (headGlobal !== undefined) hiddenIds.add(headGlobal);
          if (baseGlobal !== undefined) hiddenIds.add(baseGlobal);
        }
        break;
      }
    }
  }

  // Content matches (#1891). A retiring match (`renamed`/`moved`/`reshaped`)
  // REMOVED its pair's `added`/`deleted` entries from `diff.entries`, so the
  // loop above never saw them: without this both the A and the B copy would
  // render at full material colour in a ghosted scene — the exact stranded-mesh
  // class `excludedHiddenIds` exists to prevent. Treat them like `modified`
  // (hide A, colour B) but in the match channel's own hue.
  //
  // Review kinds (`duplicated`/`deduplicated`/`ambiguous`) retire nothing, so
  // their entries are still in `entries` with their add/delete colours. They
  // are badged in the list, never recoloured here — recolouring would claim a
  // resolution the engine explicitly declined to make.
  for (const match of diff.contentMatches ?? []) {
    if (!matchesCompareMatch(match, filter)) {
      // Review matches retain their entries: filter those through the entry
      // predicate rather than hiding an Added/Deleted result a second time.
      if (isRetiringMatch(match.kind)) {
        for (const fingerprint of [...match.base, ...match.head]) hiddenIds.add(fingerprint.ref.globalId);
      }
      continue;
    }
    if (!isRetiringMatch(match.kind)) continue;
    // The drawable-copy rule again (same as `modified`/`unchanged` above): a
    // base-meshed element re-GUIDed AND Representation-stripped retires as
    // `renamed` under data scope, and "hide A, colour B" would then hide its
    // only drawable copy while colouring a head id the renderer has no mesh
    // for. When no head copy is drawable, mark the base copies instead and
    // suppress nothing — there is no duplicate geometry to suppress.
    const drawable = drawableMatchRefs(match);
    if (match.head.some((fingerprint) => fingerprint.ref.meshed !== false)) {
      for (const fingerprint of match.base) hiddenIds.add(fingerprint.ref.globalId);
    }
    for (const ref of drawable) colorOverrides.set(ref.globalId, COMPARE_COLORS.matched);
  }

  return { colorOverrides, hiddenIds };
}
