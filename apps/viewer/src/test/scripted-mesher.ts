/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A stand-in for the wasm re-mesh worker in node tests (#6232): every add and
 * geometry edit asks `requestRemesh` for real geometry, and this answers each
 * request at once with one small triangle per target (or what `answer` says).
 * Mesh parity with the load is `scripts/lib/wasm-remesh-contracts.mjs`.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { RemeshRequest, RemeshResult } from '@ifc-lite/geometry/remesh';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';

export function triangleFor(expressId: number): MeshData {
  return {
    expressId, ifcType: 'IfcBuildingElementProxy',
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
  } as MeshData;
}

/** Install the scripted mesher; returns the requests it saw and the undo. */
export function installScriptedMesher(
  answer: (request: RemeshRequest) => MeshData[] = (request) => [...request.targets].map(triangleFor),
): { requests: RemeshRequest[]; restore: () => void } {
  const requests: RemeshRequest[] = [];
  setRemeshClientFactory(async () => ({
    alive: true,
    setConfig: () => {},
    dispose: () => {},
    styleWire: async () => ({
      styleIds: new Uint32Array(), styleColors: new Uint8Array(),
      materialElementIds: new Uint32Array(), materialColorCounts: new Uint32Array(), materialColors: new Uint8Array(),
    }),
    remesh: async (request: RemeshRequest): Promise<RemeshResult> => {
      requests.push(request);
      return { meshes: answer(request), csgFailures: 0, ms: { prepass: 0, produce: 0 } };
    },
  }));
  return { requests, restore: () => setRemeshClientFactory(null) };
}

/** Let queued re-mesh requests run to completion. */
export const settleRemesh = () => new Promise((resolve) => setTimeout(resolve, 0));
