/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

// Actual no-model/no-job canonical partitioned WASM output, not a repaired
// geometry fixture. The producer control re-generates it through the existing
// public API. SHA256 b4f6ca3b3509b77a9adc79a49a5f478b1f9449db87660d7f414d00f4119e7a07.
export function canonicalEmptyBytes() {
  return Uint8Array.from(Buffer.from('534e464901000000000000000000000000000000000000000000000000000000', 'hex')).buffer;
}

export async function produceCanonicalEmpty(sourceDir) {
  const { initSync, IfcAPI } = await import(pathToFileURL(join(sourceDir, 'packages/wasm/pkg/ifc-lite.js')).href);
  initSync({ module: readFileSync(join(sourceDir, 'packages/wasm/pkg/ifc-lite_bg.wasm')) });
  const api = new IfcAPI(); let batch, meshes;
  try {
    const u32 = new Uint32Array(), u8 = new Uint8Array();
    batch = api.processGeometryBatchPartitioned(u8, u32, 1, 0, 0, 0, false, u32, u32, u32, u32, u8);
    const bytes = batch.takeShard(); meshes = batch.takeMeshes();
    return { bytes, flatMeshes: meshes?.length, occurrences: batch.instancedOccurrences };
  } finally { meshes?.free(); batch?.free(); api.free(); }
}
