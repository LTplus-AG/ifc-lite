/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "May this pair's geometry evidence be believed?" — the capability questions
 * asked about built fingerprint sides before (`useCompare`) and while they are
 * diffed. Split from `buildFingerprints.ts`, which owns *producing* the
 * fingerprints; everything here only reads them.
 */

import type { EntityFingerprint } from '@ifc-lite/diff';
import type { CompareRef } from './buildFingerprints.js';

/**
 * Do a model's proved volumes (#1993) still describe its geometry after
 * federation alignment put it where it now is? See
 * {@link BuildFingerprintsModel.geometryVolumesTrusted}.
 *
 * Defined in `./alignmentTrust.js` — the single source of truth, shared with
 * the Measure tool (#2199), render-frame offsets and zone apportionment, none
 * of which may pull `@ifc-lite/diff` into their chunk — and re-exported here
 * for the compare pipeline's capability questions.
 */
export { geometryVolumesSurviveAlignment } from './alignmentTrust.js';

/** Does this side carry at least one usable MESH geometry hash? Compares run
 *  on models loaded outside the WASM mesh path (e.g. huge native desktop
 *  loads) produce no hashes, which would make mesh-geometry diffs silently
 *  read every element as unchanged — callers warn when this is false.
 *
 *  A `p:`-prefixed composed-placement fingerprint (`worldPlacement.ts`) does
 *  not count: it exists for geometry-less products and says nothing about the
 *  meshed population this warning is about. Nearly every model has a site or
 *  a storey, so counting placements would turn the answer into an
 *  unconditional yes and retire the warning exactly where it is needed. */
export function hasGeometryHashes(side: readonly EntityFingerprint<CompareRef>[]): boolean {
  return side.some(
    (fingerprint) =>
      fingerprint.geometryHash !== undefined && !isPlacementFingerprint(fingerprint.geometryHash),
  );
}

/** Is this `geometryHash` a composed-placement fingerprint rather than a WASM
 *  mesh hash? The `p:` prefix is `worldPlacement.ts`'s namespace; a mesh hash
 *  is a `bigint` (or its all-decimal string form) and can never carry it. */
function isPlacementFingerprint(hash: bigint | string): boolean {
  return typeof hash === 'string' && hash.startsWith('p:');
}

/** The whole geometry-capability decision for one built pair, in one place. */
export interface GeometryChannelResolution {
  /** Ask resident models to strip placements for a mixed-capability pair. */
  stripPlacementGeometry: boolean;
  /** At least one side has no usable MESH hashes, so mesh-shape changes
   *  cannot be detected — the panel warns on this. */
  geometryUnavailable: boolean;
  /**
   * `geometryUnavailable`, but placement fingerprints are still in play: the
   * pair is capability-SYMMETRIC (both sides mesh-less, so nothing was
   * stripped) and at least one side carries a composed-placement fingerprint.
   * The geometry channel then still reports placement-driven MOVES while
   * staying blind to reshapes — a warning phrased as "geometry changes can't
   * be detected" would contradict the panel's own rows the moment a site
   * moves, so the caller must phrase this case as "reshapes invisible,
   * placement moves still compared".
   */
  placementOnlyGeometry: boolean;
}

/**
 * Resolve what the diff engine may believe about a pair's geometry evidence —
 * strip decision, warning flag and the placement-only nuance together, so the
 * warning can never disagree with what the engine was actually given.
 *
 * - Both sides mesh-hashed: full geometry channel, no warning.
 * - Exactly one side mesh-hashed (MIXED): placement fingerprints stripped from
 *   BOTH sides via the engine's `stripPlacementGeometry` option so its
 *   asymmetry abstention can fire; warn.
 * - Neither side mesh-hashed (symmetric): placements kept — two same-pipeline
 *   loads compare placements soundly — so warn, but flag the warning as
 *   placement-aware when any placement fingerprint exists.
 */
export function resolveGeometryChannel(
  base: readonly EntityFingerprint<CompareRef>[],
  head: readonly EntityFingerprint<CompareRef>[],
): GeometryChannelResolution {
  const baseHasMeshHashes = hasGeometryHashes(base);
  const headHasMeshHashes = hasGeometryHashes(head);
  const symmetric = baseHasMeshHashes === headHasMeshHashes;
  const geometryUnavailable = !baseHasMeshHashes || !headHasMeshHashes;
  const hasPlacement = (side: readonly EntityFingerprint<CompareRef>[]): boolean =>
    side.some(
      (fingerprint) =>
        fingerprint.geometryHash !== undefined && isPlacementFingerprint(fingerprint.geometryHash),
    );
  return {
    stripPlacementGeometry: !symmetric,
    geometryUnavailable,
    placementOnlyGeometry:
      geometryUnavailable && symmetric && (hasPlacement(base) || hasPlacement(head)),
  };
}
