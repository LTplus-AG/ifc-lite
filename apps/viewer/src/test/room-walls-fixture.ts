/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test-only walls for the Room tool (charter #6232 M4): rendered wall meshes
 * (the input the tool reads, decision D4) put into the modeling session's
 * geometry, and the IfcSpaces the tool wrote read back with their
 * storey-local footprints. Walls are 0.2 m thick with their axes on the
 * given lines, in the render frame (Y up, render z = −IFC y).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { initSync } from '@ifc-lite/wasm';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import type { Vec2 } from '@/lib/snap/types';
import { MODEL_ID } from './modeling-session-fixture';

export type Wall = [Vec2, Vec2];

const wasmPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'packages', 'wasm', 'pkg', 'ifc-lite_bg.wasm');
let wasmReady = false;

/** Load the real wasm (the DCEL), or skip the test when the bundle isn't built. */
export function ensureRoomWasm(t: TestContext): boolean {
  if (!existsSync(wasmPath)) {
    t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh` first');
    return false;
  }
  if (!wasmReady) {
    initSync({ module: readFileSync(wasmPath) });
    wasmReady = true;
  }
  return true;
}

export const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** A wall's box mesh from `a` to `b` (storey-local plan, metres), 0.2 m thick, from `z0` to `z1`. */
export function wallMesh(expressId: number, a: Vec2, b: Vec2, z0 = 0, z1 = 3, thickness = 0.2): MeshData {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const nx = -(b[1] - a[1]) / len * thickness / 2, ny = (b[0] - a[0]) / len * thickness / 2;
  const plan: Vec2[] = [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
  const positions = new Float32Array([z0, z1].flatMap((h) => plan.flatMap(([x, y]) => [x, h, -y])));
  return {
    expressId, ifcType: 'IfcWall', positions, normals: new Float32Array(positions.length),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]), color: [0.8, 0.8, 0.8, 1],
  } as MeshData;
}

/** An 8 × 5 m box, axes on the grid lines. */
export const BOX: Wall[] = [[[0, 0], [8, 0]], [[8, 0], [8, 5]], [[8, 5], [0, 5]], [[0, 5], [0, 0]]];

/** Put these walls (storey L0, 0–3 m; `upper`: L1, 3–6 m) in the model's rendered geometry, as a re-mesh would. */
export function setWallMeshes(walls: readonly Wall[], upper: readonly Wall[] = [], thickness = 0.2): void {
  const meshes = [
    ...walls.map(([a, b], i) => wallMesh(9000 + i, a, b, 0, 3, thickness)),
    ...upper.map(([a, b], i) => wallMesh(9500 + i, a, b, 3, 6, thickness)),
  ];
  const s = useViewerStore.getState();
  const model = s.models.get(MODEL_ID)!;
  const geometryResult = { ...model.geometryResult, meshes } as GeometryResult;
  useViewerStore.setState({ models: new Map([[MODEL_ID, { ...model, geometryResult }]]), geometryResult });
}

/** Every live IfcSpace the tool wrote, with its storey-local footprint (metres). */
export function authoredSpaces(): { id: number; name: string; guid: string; footprint: Vec2[] }[] {
  const s = useViewerStore.getState();
  const view = s.mutationViews.get(MODEL_ID)!;
  return view.getNewEntities()
    .filter((e) => e.type.toUpperCase() === 'IFCSPACE' && !view.isDeleted(e.expressId))
    .map((e) => ({
      id: e.expressId,
      name: String(e.attributes[2]),
      guid: String(e.attributes[0]),
      footprint: s.readSlabFootprint(MODEL_ID, e.expressId)!.footprint.map(([x, y]) => [r3(x), r3(y)] as Vec2),
    }));
}

/** A ring as a start- and direction-independent sorted corner list. */
export const corners = (ring: readonly Vec2[]) => ring.map(([x, y]) => `${r3(x)},${r3(y)}`).sort();

/** Absolute shoelace area. */
export function ringArea(ring: readonly Vec2[]): number {
  let a = 0;
  ring.forEach((p, i) => { const q = ring[(i + 1) % ring.length]; a += p[0] * q[1] - q[0] * p[1]; });
  return Math.abs(a) / 2;
}

/** A space's `Qto_SpaceBaseQuantities` value. */
export function spaceQuantity(id: number, name: string): number | undefined {
  const q = useViewerStore.getState().mutationViews.get(MODEL_ID)!.getQuantitiesForEntity(id)
    .find((set) => set.name === 'Qto_SpaceBaseQuantities')?.quantities.find((v) => v.name === name)?.value;
  return q === undefined ? undefined : Number(q);
}
