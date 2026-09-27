/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Messages between `RemeshClient` and `remesh.worker.ts` (#6232 WP1). */

import type { MeshData } from '../types.js';
import type { RemeshConfig, RemeshRequest, RemeshResult, StyleWire } from './remesh-core.js';

export type RemeshWorkerInbound =
  | { type: 'init'; config: RemeshConfig; wasmModule?: WebAssembly.Module; wasmUrl?: string }
  | { type: 'config'; config: RemeshConfig }
  | { type: 'remesh'; requestId: number; request: RemeshRequest }
  | { type: 'style-wire'; requestId: number; source: Uint8Array };

export type RemeshWorkerOutbound =
  | { type: 'ready' }
  | { type: 'init-error'; message: string }
  | { type: 'result'; requestId: number; result: RemeshResult }
  | { type: 'style-wire'; requestId: number; wire: StyleWire }
  | { type: 'error'; requestId: number; message: string };

/** The large per-mesh buffers, moved rather than copied across the boundary. */
export function meshTransferables(meshes: readonly MeshData[]): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const mesh of meshes) {
    for (const view of [mesh.positions, mesh.normals, mesh.indices, mesh.uvs]) {
      if (view && view.buffer instanceof ArrayBuffer) buffers.add(view.buffer);
    }
  }
  return [...buffers];
}

/** The wire's buffers, moved back to the caller. */
export function styleWireTransferables(wire: StyleWire): ArrayBuffer[] {
  return [wire.styleIds, wire.styleColors, wire.materialElementIds, wire.materialColorCounts, wire.materialColors]
    .flatMap((view) => (view.buffer instanceof ArrayBuffer ? [view.buffer] : []));
}
