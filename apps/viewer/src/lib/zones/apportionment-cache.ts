/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cache shape + invalidation key for zone volume apportionment (issue #2508).
 *
 * Apportionment is NEVER part of model load: clipping is memory-bandwidth
 * bound, more workers gave zero speedup and threaded wasm measured 0.87x on the
 * full pipeline, so the only way to win is to do less work. It runs on demand,
 * for straddlers only, and the result is cached until the zones move.
 *
 * Invalidation is by REVISION rather than by clearing the cache from each of
 * the seven zone mutators in `zonesSlice`. A mutator that forgets to clear is
 * invisible until someone notices stale cubic metres; a revision checked on
 * READ cannot be forgotten, because the reader computes it from the zone set it
 * is reading against. `zoneSets` is immutably replaced on every edit, so this
 * costs one string build per read of a set, not per element.
 */

import type { ElementApportionment } from './apportionment.js';
import type { ZoneSet } from './types.js';

/** Why an element has no apportionment. Each is a different modelling
 *  situation with a different fix, so they are not collapsed into one
 *  "unavailable" — the same reasoning `GeometryClosure` uses for its four
 *  separate topology bits. */
export type ApportionmentRefusal =
  /** The renderer has no CPU triangles for it: never had geometry, or geometry
   *  was released to reclaim memory (#2183). */
  | 'no-geometry'
  /** The mesher could not prove a single closed orientable solid (#1891/#1993),
   *  so no volume may be stated for it at all — let alone split. */
  | 'unproved-solid'
  /**
   * The element's model was RE-BAKED by federation alignment (`'same-crs'` /
   * `'reprojected'`), so the kernel's proved volume describes geometry at a
   * size that is no longer on screen and cannot serve as the cross-check
   * `volumeGateVerdict` needs. Distinct from `'unproved-solid'` on purpose: the
   * kernel DID prove this one, and the fix is on the federation side (re-anchor
   * so this model is not re-based) rather than in the model's geometry.
   *
   * Not repaired by rescaling the stored volume, because `'reprojected'` is a
   * per-vertex proj4 hop with no single scale factor to apply.
   */
  | 'rescaled-by-alignment';

/** One zone set's apportionment results, valid only while `revision` matches. */
export interface ZoneApportionmentEntry {
  /** {@link zoneSetRevision} at the time the entries were computed. */
  revision: string;
  /** globalId -> per-zone breakdown, for elements that produced one. */
  byElement: Map<number, ElementApportionment>;
  /** globalId -> why not, for elements that did not. Kept rather than dropped:
   *  a total that quietly omits elements is worse than one that says how many
   *  it omitted (#2508's "silently unclassified" note). */
  refused: Map<number, ApportionmentRefusal>;
  computedAt: number;
  elapsedMs: number;
}

/** `zoneSetId -> entry`. */
export type ZoneApportionmentCache = ReadonlyMap<string, ZoneApportionmentEntry>;

/**
 * Everything about a zone set that can change an apportioned number: each
 * zone's id, name (it is printed next to the value), oriented box and order.
 *
 * `updatedAt` is deliberately NOT used. It moves when a set is renamed or its
 * visibility toggles, neither of which changes a single cubic metre, and
 * throwing away a whole model's clip results for a rename is exactly the
 * needless work this feature exists to avoid.
 */
export function zoneSetRevision(zoneSet: ZoneSet): string {
  const parts: string[] = [];
  for (const z of zoneSet.zones) {
    // LENGTH-PREFIXED, not delimited. Ids and names are free text a user types,
    // so any separator character can appear inside one, and two DIFFERENT zone
    // lists can then concatenate to the same string (see the collision test).
    // A collision here serves stale cubic metres for zones that have moved,
    // which is the one failure this function exists to prevent.
    parts.push(
      `${z.id.length}:${z.id}${z.name.length}:${z.name}`,
      `${z.center[0]},${z.center[1]},${z.center[2]};`,
      `${z.size[0]},${z.size[1]},${z.size[2]};${z.rotationY};`,
      // The FOOTPRINT of a prism zone (#2508 item 4). Two prisms can share a
      // bounding box and cut differently -- move any vertex that is not a
      // bounding-box extreme and the box fields above do not move at all -- so
      // omitting it serves the old polygon's cubic metres for the new one.
      // Length-prefixed like the ids, for the same reason.
      z.footprint ? `${z.footprint.length}:${z.footprint.map((p) => `${p[0]},${p[1]}`).join(';')};` : '0;',
    );
  }
  return parts.join('');
}

/** The entry for `zoneSet`, or `null` when there is none or it predates the
 *  set's current geometry. The only supported way to read the cache. */
export function validEntry(
  cache: ZoneApportionmentCache,
  zoneSet: ZoneSet,
): ZoneApportionmentEntry | null {
  const entry = cache.get(zoneSet.id);
  if (!entry) return null;
  return entry.revision === zoneSetRevision(zoneSet) ? entry : null;
}

/**
 * How far the clipper's own whole-mesh volume may differ from the kernel's
 * proved `geometryVolume` before an element is refused.
 *
 * Two independent producers over the same triangles: the Rust kernel's
 * `signed_volume6` at mesh time, and the divergence sum here over the f32
 * buffers the renderer kept. They agree to f32 rounding on a genuine solid.
 * They do NOT agree when the geometry the Scene holds is not the geometry the
 * kernel measured -- a colour-merged batch re-extracted per entity
 * (`Scene.extractEntityFromMergedMesh`) keeps only triangles whose three
 * vertices all belong to the entity, and a silently short mesh is exactly the
 * confidently-wrong number the closure gate exists to refuse. 1% is far wider
 * than f32 noise (measured worst 3.4e-6 relative) and far narrower than a
 * dropped face.
 */
export const PROVED_VOLUME_AGREEMENT_REL = 0.01;

/**
 * May this element's clipped volumes be published?
 *
 * `'ok'` demands all three: the renderer has triangles, the mesher PROVED a
 * single closed orientable solid for it (#1891/#1993 -- 32 to 40% of meshed
 * elements in real models do not qualify), and the two producers agree. A
 * divergence-theorem volume over an open shell is not approximately right, it
 * is arbitrary: one measured open beam apportioned to -1.071 m3 against a whole
 * of 0.954 m3.
 *
 * Pure, so the rule that decides whether any of these numbers may be shown at
 * all is testable without a renderer.
 */
export function volumeGateVerdict(
  provedVolumeM3: number | undefined,
  clipped: { wholeVolumeM3: number; unreliable: boolean } | null,
  agreementRel: number = PROVED_VOLUME_AGREEMENT_REL,
  provedRescaledByAlignment = false,
): 'ok' | ApportionmentRefusal {
  if (!clipped) return 'no-geometry';
  // Checked BEFORE the agreement test, and reported as its own refusal. The
  // stored volume and the clipper's would disagree by exactly the alignment's
  // scale, so leaving this to the 1% test would label a kernel-proved solid
  // 'unproved-solid' -- a true refusal for a false reason, pointing whoever
  // reads it at the element's geometry instead of at the federation.
  if (provedRescaledByAlignment) return 'rescaled-by-alignment';
  if (provedVolumeM3 === undefined || !Number.isFinite(provedVolumeM3)) return 'unproved-solid';
  if (clipped.unreliable) return 'unproved-solid';
  const scale = Math.max(Math.abs(provedVolumeM3), Math.abs(clipped.wholeVolumeM3));
  if (scale > 0 && Math.abs(clipped.wholeVolumeM3 - provedVolumeM3) > scale * agreementRel) {
    return 'unproved-solid';
  }
  return 'ok';
}

/** Counts for the "what did this leave out" line the UI owes the user. */
export interface ApportionmentCoverage {
  apportioned: number;
  noGeometry: number;
  unprovedSolid: number;
  rescaledByAlignment: number;
}

export function coverageOf(entry: ZoneApportionmentEntry | null): ApportionmentCoverage {
  const zero: ApportionmentCoverage = {
    apportioned: 0, noGeometry: 0, unprovedSolid: 0, rescaledByAlignment: 0,
  };
  if (!entry) return zero;
  const counts = { ...zero };
  // Switched on EXHAUSTIVELY rather than with an `else`: an `else` silently
  // files every future refusal reason under whichever bucket it guards, which
  // is how a reason that needs a different fix gets reported as one that does
  // not.
  for (const reason of entry.refused.values()) {
    switch (reason) {
      case 'no-geometry': counts.noGeometry++; break;
      case 'unproved-solid': counts.unprovedSolid++; break;
      case 'rescaled-by-alignment': counts.rescaledByAlignment++; break;
    }
  }
  return { ...counts, apportioned: entry.byElement.size };
}
