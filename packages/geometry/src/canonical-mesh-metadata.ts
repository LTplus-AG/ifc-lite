/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from './types.js';
import type { EntityGeometryFingerprint } from './geometry-fingerprints.js';

/** The worker and collection fallback stamp identical canonical source metadata
 * before any renderer streaming split. Repeated array references survive clone. */
export function attachCanonicalMeshMetadata(
  mesh: MeshData,
  fingerprint?: EntityGeometryFingerprint,
): void {
  if (mesh.geometryItemId !== undefined) {
    mesh.appearanceSource = {
      kind: 'canonical-item',
      indices: mesh.indices,
      sourceIndices: mesh.indices,
    };
  }
  if (fingerprint) {
    mesh.geometryHash = fingerprint.hash;
    if (fingerprint.aabb) mesh.geometryAabb = fingerprint.aabb;
    if (fingerprint.volume !== undefined) mesh.geometryVolume = fingerprint.volume;
  }
}
