/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Real exported-STEP oracle shared by core and mounted stair tests (#6232). */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const wasm = fileURLToPath(new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
export const stairWasmAvailable = existsSync(wasm);
export interface StairMesh { positions: number[]; indices: number[]; color: number[] }

export async function meshStairs(text: string): Promise<Map<number, StairMesh[]>> {
  const { IfcAPI, initSync } = await import('@ifc-lite/wasm');
  initSync({ module: readFileSync(wasm) });
  const api = new IfcAPI(), bytes = new TextEncoder().encode(text);
  try {
    const pre = api.buildPrePassOnce(bytes);
    const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, 0, 0, 0, false,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    try {
      const out = new Map<number, StairMesh[]>();
      for (let i = 0; i < collection.length; i++) {
        const mesh = collection.get(i);
        if (!mesh) continue;
        try {
          // Fixtures sit near the origin: no RTC rebase. Convert the complete
          // triangle positions from viewer Y-up into IFC world Z-up metres.
          const p = mesh.positions, o = mesh.origin, positions: number[] = [];
          for (let k = 0; k < p.length; k += 3) positions.push(o[0] + p[k], -(o[2] + p[k + 2]), o[1] + p[k + 1]);
          const parts = out.get(mesh.expressId) ?? [];
          parts.push({ positions, indices: Array.from(mesh.indices), color: Array.from(mesh.color) });
          out.set(mesh.expressId, parts);
        } finally { mesh.free(); }
      }
      return out;
    } finally { collection.free(); }
  } finally { api.clearPrePassCache(); api.free(); }
}

export function stairMeshBounds(meshes: StairMesh[]) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) for (let i = 0; i < mesh.positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3], mesh.positions[i]);
    max[i % 3] = Math.max(max[i % 3], mesh.positions[i]);
  }
  return { min, max };
}
