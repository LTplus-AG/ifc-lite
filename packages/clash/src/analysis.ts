/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure helpers for reading and ordering a clash result the way a reviewer
 * thinks about it: how deep the overlap is, whether a "clash" is really just a
 * face/edge contact, and which conflicts to look at first.
 *
 * Severity itself is a property of the *element-type pair* (see
 * {@link inferClashSeverity}), NOT of the overlap geometry — so a deep pipe-vs-
 * beam interpenetration and a shallow one share a severity. These helpers add
 * the geometric dimension (depth) so the two can be combined when prioritising.
 */

import type { Clash, ClashSeverity } from './types.js';

/** Severity ordering, most-severe first (lower rank = more severe). */
export const SEVERITY_RANK: Record<ClashSeverity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  info: 3,
};

/**
 * Overlap (penetration) depth of a clash in metres, always `>= 0`.
 *
 * A `hard` clash carries a *signed* `distance` (`< 0` = interpenetration), so
 * its depth is `-distance`. `clearance`/`touch` clashes are separated (no
 * penetration) and report depth `0`. This is the right key for "sort by how
 * badly things overlap" (#1274).
 */
export function penetrationDepth(c: Clash): number {
  return c.distance < 0 ? -c.distance : 0;
}

/** Default band (m) under which a `hard` clash is really a face/edge *contact*
 *  rather than a genuine interpenetration — see {@link isTouching}. */
export const TOUCHING_EPSILON = 1e-4;

/**
 * Whether a clash is effectively a zero-distance *contact* rather than a real
 * overlap (#1273). True for `touch`-status clashes and for `hard` clashes whose
 * penetration is within `eps` — typically coincident faces (a wall meeting a
 * slab, a column sitting on a footing) reported with a ~0 m depth, which users
 * reasonably distrust when they appear in the clash list.
 */
export function isTouching(c: Clash, eps: number = TOUCHING_EPSILON): boolean {
  return c.status === 'touch' || (c.status === 'hard' && penetrationDepth(c) <= eps);
}

export type ClashSortBy = 'severity' | 'depth' | 'distance';

function cmpId(a: Clash, b: Clash): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Return a NEW array of clashes ordered by the chosen key. Ties fall back to the
 * stable clash id so the order is deterministic across runs.
 * - `severity`: most severe first, then deepest overlap (the panel default).
 * - `depth`:    deepest interpenetration first (#1274 — prioritise real problems).
 * - `distance`: smallest signed distance first (deepest penetration → widest gap).
 */
export function sortClashes(clashes: readonly Clash[], by: ClashSortBy): Clash[] {
  const out = clashes.slice();
  switch (by) {
    case 'severity':
      out.sort(
        (a, b) =>
          SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
          penetrationDepth(b) - penetrationDepth(a) ||
          cmpId(a, b),
      );
      break;
    case 'depth':
      out.sort((a, b) => penetrationDepth(b) - penetrationDepth(a) || cmpId(a, b));
      break;
    case 'distance':
      out.sort((a, b) => a.distance - b.distance || cmpId(a, b));
      break;
  }
  return out;
}
