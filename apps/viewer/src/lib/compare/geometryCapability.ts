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

/**
 * The same side with every composed-placement fingerprint removed — mesh
 * hashes, refs and everything else pass through by identity.
 *
 * For a MIXED-CAPABILITY pair only: when exactly one side of a compare carries
 * mesh hashes (`hasGeometryHashes` disagrees — e.g. one model loaded outside
 * the WASM mesh path), the engine must abstain from geometry classification,
 * or `geometryEqual(bigint, undefined)` reports the entire meshed population
 * as modified. That abstention (`resolveUseGeometry`) asks "does this side
 * carry ANY geometry hash?", and placement fingerprints — present on any model
 * with a placed site or storey, i.e. essentially all of them — would make the
 * answer an unconditional yes on both sides and permanently defeat it. The
 * caller (`useCompare`) strips them from BOTH sides in that situation, giving
 * up placement detection for a pair whose geometry channel is untrustworthy
 * anyway; a capability-symmetric pair keeps them and never comes here.
 */
export function withPlacementFingerprintsStripped(
  side: readonly EntityFingerprint<CompareRef>[],
): EntityFingerprint<CompareRef>[] {
  return side.map((fingerprint) =>
    fingerprint.geometryHash !== undefined && isPlacementFingerprint(fingerprint.geometryHash)
      ? { ...fingerprint, geometryHash: undefined }
      : fingerprint,
  );
}
