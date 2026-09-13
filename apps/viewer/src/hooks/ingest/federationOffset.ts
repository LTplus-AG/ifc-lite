/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Re-home, in place, every express id one flat mesh carries onto the
 * federation's global id space: **every express id on a mesh is global once
 * this has run.**
 *
 * Why the whole mesh must move together. Resolving a global id back to
 * (model, expressId) is RANGE-based (`modelSlice.resolveGlobalIdFromModels`,
 * `FederationRegistry.fromGlobalId` / `getModelForGlobalId`), so an id left
 * unshifted does not resolve to nothing — it lands in whichever model's range
 * contains the raw local number, which for a small item id in a model loaded at
 * offset 1,000,000 is the PRIMARY model. A real entity in the wrong model is a
 * plausible answer, and nothing downstream can tell it from a correct one.
 *
 * The ids: `expressId` (the element); `textureRef.textureId`, an express id too
 * (#1781), or model B's texture `#34` samples model A's image out of the
 * renderer's shared registry; `geometryItemId`, the `IfcRepresentationItem` the
 * mesh was tessellated from (#2985/#3199) — `Scene.getInstancedMeshDataPieces`
 * is already called with a GLOBAL id (`useZoneGeometrySplit`,
 * `useZoneApportionment`), so an unshifted item id beside a shifted `expressId`
 * on one mesh is exactly the mixed-space case above.
 *
 * `materialId`, the other #3199 source id, is an `IfcMaterial` express id from
 * the same file as `expressId`, so it moves with it too: every TS-side
 * consumer only copies it (census: PR #3525; #3211's Rust lookups differ).
 *
 * Absence must stay absence: `geometryItemId` is legitimately absent, and both
 * naive shifts are wrong in a way a "the number changed" test accepts —
 * `undefined + idOffset` is `NaN`, `(x ?? 0) + idOffset` invents the bare
 * offset, itself a resolvable wrong answer — while a truthiness guard would
 * drop a real `0`. Hence `typeof === 'number'`.
 *
 * The instanced half is `applyFederationOffsetToShard` in
 * `useGeometryStreaming.ts`; a `MeshData` and a `DecodedInstance` are different
 * shapes, so they are two functions, tested together so they cannot drift.
 *
 * Lives beside the ingest helpers rather than in `useIfcLoader.ts` because the
 * collab recipient path (`lib/collab/room-reconstruct.ts`) re-homes hydrated
 * room meshes the same way (#4444), and a store slice cannot import the loader
 * hook module without a cycle.
 */

import type { MeshData } from '@ifc-lite/geometry';

export function applyFederationOffsetToMesh(mesh: MeshData, idOffset: number): void {
  if (idOffset <= 0) return;
  mesh.expressId = mesh.expressId + idOffset;
  if (mesh.textureRef) {
    mesh.textureRef = { ...mesh.textureRef, textureId: mesh.textureRef.textureId + idOffset };
  }
  if (typeof mesh.geometryItemId === 'number') mesh.geometryItemId = mesh.geometryItemId + idOffset;
  if (typeof mesh.materialId === 'number') mesh.materialId = mesh.materialId + idOffset;
}
