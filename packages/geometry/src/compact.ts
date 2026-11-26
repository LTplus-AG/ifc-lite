/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `@ifc-lite/geometry/compact`: compact GPU-record meshes (`MeshData.compact`)
 * for the code that draws or reads them. A subpath of its own because it is
 * small and pure: importing it loads neither the wasm engine the package root
 * brings in nor the record decoder, which `loadCompactGeometry` fetches when a
 * host turns compact records on.
 */

export { compactBounds, compactRow, compactStep, isCompactCellSize, visitCompactPayload, COMPACT_CELL_METRES, COMPACT_RECORD_BYTES, type CompactPayload, type CompactRef } from './compact-geometry.js';
export { adoptCompactMeshes, compactHydrationStats, compactMeshBounds, copyMeshShell, loadCompactGeometry, materializeCompactMesh, materializeCompactMeshes, meshTriangleCount, meshVertexCount } from './compact-mesh.js';
