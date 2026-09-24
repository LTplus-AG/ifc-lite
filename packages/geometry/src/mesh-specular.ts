/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared by the two WASM `MeshCollection` → `MeshData[]` converters
 * (`geometry.worker.ts`, `geometry-coordinate.ts`, #5582): read the
 * IFC-authored metallic/roughness getters and shape them into
 * {@link MeshData.material}, or `undefined` when neither field is present
 * (an older wasm bundle, or the file authored no specular evidence).
 */
export function readSpecularMaterial(mesh: {
  metallic?: number;
  roughness?: number;
}): { metallic?: number; roughness?: number } | undefined {
  const { metallic, roughness } = mesh;
  if (metallic === undefined && roughness === undefined) return undefined;
  return {
    ...(metallic !== undefined ? { metallic } : {}),
    ...(roughness !== undefined ? { roughness } : {}),
  };
}
