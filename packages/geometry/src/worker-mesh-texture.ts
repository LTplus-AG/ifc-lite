/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Surface texture extraction for the geometry worker's mesh loop
 * (`collectMeshes` in geometry.worker.ts), kept out of that module for its
 * size budget.
 */

import type { MeshData } from './types.js';
import { ownedWasmBuffer } from './wasm-owned-buffer.js';

/** The texture getters of a wasm `MeshDataJs`. */
interface TexturedWasmMesh {
  readonly hasTexture: boolean;
  readonly uvs: Float32Array;
  readonly textureRgba: Uint8Array;
  readonly textureWidth: number;
  readonly textureHeight: number;
  readonly textureRepeatS: boolean;
  readonly textureRepeatT: boolean;
  readonly textureId: number;
  readonly textureUrl?: string;
}

/**
 * Copy a mesh's surface texture (or its external image reference) and UVs onto
 * `meshData`, queueing their buffers on `transfers`. Returns the bytes added.
 */
export function attachMeshTexture(mesh: TexturedWasmMesh, meshData: MeshData, transfers: ArrayBuffer[]): number {
  // #961: surface texture + per-vertex UVs (decoded to RGBA8 in Rust). Carried
  // as transferables so there is no SAB→scratch copy (see SAB-streaming memo).
  if (mesh.hasTexture) {
    const uvs = mesh.uvs;
    const rgba = mesh.textureRgba;
    meshData.uvs = uvs;
    meshData.texture = {
      rgba,
      width: mesh.textureWidth,
      height: mesh.textureHeight,
      repeatS: mesh.textureRepeatS,
      repeatT: mesh.textureRepeatT,
    };
    transfers.push(ownedWasmBuffer(uvs), ownedWasmBuffer(rgba));
    return uvs.byteLength + rgba.byteLength;
  }
  if (mesh.textureUrl) {
    // #1781: external image reference (`IfcImageTexture`) — UVs travel as
    // a transferable like #961, but the texture itself is only a URL +
    // repeat flags; the main thread resolves it against the `.ifcZIP`
    // sibling images and decodes ONCE per `textureId`.
    const uvs = mesh.uvs;
    meshData.uvs = uvs;
    meshData.textureRef = {
      textureId: mesh.textureId,
      url: mesh.textureUrl,
      repeatS: mesh.textureRepeatS,
      repeatT: mesh.textureRepeatT,
    };
    transfers.push(ownedWasmBuffer(uvs));
    return uvs.byteLength;
  }
  return 0;
}
