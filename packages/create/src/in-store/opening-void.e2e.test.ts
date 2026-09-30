/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End to end for the in-store opening builders (#6232 M3): author a hosted
 * door into a real Bonsai wall through the mutation overlay, export with
 * `StepExporter` (the export path for modified models), re-parse the file,
 * and mesh it with the real wasm geometry pipeline. The host wall must come
 * back with a void where the door is: less volume by the opening's share of
 * the body, and a ray through the opening's centre that no longer hits it.
 *
 * Skips (never fails) when `packages/wasm/pkg/ifc-lite_bg.wasm` is not built
 * on this host — see `pnpm build:wasm:fetch`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { addHostedElementInStore } from './hosted-element.js';

const WASM_PATH = fileURLToPath(new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const WASM_AVAILABLE = existsSync(WASM_PATH);
const SAMPLE = fileURLToPath(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
const WALL = 1222;

type Vec3 = [number, number, number];
interface Mesh { ifcType: string; positions: Float32Array; indices: Uint32Array }
interface Meshed { meshes: Map<number, Mesh[]>; volumes: Map<number, number> }

function mesh(api: IfcAPI, content: string): Meshed {
  const bytes = new TextEncoder().encode(content);
  api.setComputeGeometryHashes(1e-3);
  const pre = api.buildPrePassOnce(bytes);
  const meshes = new Map<number, Mesh[]>();
  const volumes = new Map<number, number>();
  try {
    const [x, y, z] = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
    const collection = api.processGeometryBatch(
      bytes, pre.jobs, pre.unitScale, x, y, z, pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
    );
    try {
      for (let i = 0; i < collection.length; i++) {
        const m = collection.get(i);
        if (!m) continue;
        const list = meshes.get(m.expressId) ?? [];
        list.push({ ifcType: m.ifcType, positions: m.positions, indices: m.indices });
        meshes.set(m.expressId, list);
        m.free();
      }
      const ids = collection.geometryHashIds;
      const values = collection.geometryVolumeValues;
      for (let i = 0; i < ids.length; i++) volumes.set(ids[i], values[i]);
    } finally {
      collection.free();
    }
  } finally {
    api.clearPrePassCache();
  }
  return { meshes, volumes };
}

/** Möller–Trumbore: does the ray `origin + t·dir` (t > 0) hit any triangle? */
function rayHits(meshes: Mesh[], origin: Vec3, dir: Vec3): boolean {
  for (const { positions: p, indices } of meshes) {
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [indices[i] * 3, indices[i + 1] * 3, indices[i + 2] * 3];
      const e1: Vec3 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
      const e2: Vec3 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
      const h = cross(dir, e2);
      const det = dot(e1, h);
      if (Math.abs(det) < 1e-12) continue;
      const s: Vec3 = [origin[0] - p[a], origin[1] - p[a + 1], origin[2] - p[a + 2]];
      const u = dot(s, h) / det;
      if (u < 0 || u > 1) continue;
      const q = cross(s, e1);
      const v = dot(dir, q) / det;
      if (v < 0 || u + v > 1) continue;
      if (dot(e2, q) / det > 1e-9) return true;
    }
  }
  return false;
}
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function minCorner(meshes: Mesh[]): Vec3 {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  for (const { positions } of meshes) {
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) min[k] = Math.min(min[k], positions[i + k]);
    }
  }
  return min;
}

/**
 * Ray across the wall's thickness at `along` metres from its start and `up`
 * metres above its base. Meshes are WebGL Y-up (IFC `(x, y, z)` -> `(x, z, -y)`),
 * so the wall runs along X, up is Y and the thickness is Z.
 */
function throughWall(meshes: Mesh[], along: number, up: number): { origin: Vec3; dir: Vec3 } {
  const min = minCorner(meshes);
  return { origin: [min[0] + along, min[1] + up, min[2] - 1], dir: [0, 0, 1] };
}

async function exportWithDoor(): Promise<string> {
  const source = readFileSync(SAMPLE);
  const store = await new IfcParser().parseColumnar(
    source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
  const view = new MutablePropertyView(null, 'm');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  const editor = new StoreEditor(store, view);
  addHostedElementInStore(store, editor, WALL, { kind: 'door', params: {
    Offset: 8, Width: 0.9, Height: 2.1, Name: 'Authored Door',
  } });
  const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });
  return new TextDecoder().decode(result.content);
}

describe.skipIf(!WASM_AVAILABLE)('hosted door -> StepExporter -> wasm mesh (#6232)', () => {
  let api: IfcAPI;
  beforeAll(() => {
    initSync({ module: readFileSync(WASM_PATH) });
    api = new IfcAPI();
  });

  it('exports a file that re-parses with the opening, fill and void relationships', async () => {
    const text = await exportWithDoor();
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(text).buffer as ArrayBuffer,
      { disableWorkerScan: true },
    );
    const ids = (type: string) => store.entityIndex.byType.get(type) ?? [];
    // The sample already carries two window openings; the door adds one of each.
    expect(ids('IFCOPENINGELEMENT')).toHaveLength(3);
    expect(ids('IFCRELVOIDSELEMENT')).toHaveLength(3);
    expect(ids('IFCRELFILLSELEMENT')).toHaveLength(3);
    expect(ids('IFCDOOR')).toHaveLength(1);
    expect(text).toMatch(/IFCRELVOIDSELEMENT\('.{22}',\$,\$,\$,#1222,#\d+\)/);
  });

  it('meshes the host wall with a void where the door was cut', async () => {
    const before = mesh(api, readFileSync(SAMPLE, 'utf8'));
    const after = mesh(api, await exportWithDoor());

    const wallBefore = before.meshes.get(WALL) ?? [];
    const wallAfter = after.meshes.get(WALL) ?? [];
    expect(wallBefore.length).toBeGreaterThan(0);
    expect(wallAfter.length).toBeGreaterThan(0);

    // A ray across the wall at the door's centre hits it before the cut and
    // passes through the void after; the one through the solid part still hits.
    const centre = throughWall(wallBefore, 8, 1.05);
    expect(rayHits(wallBefore, centre.origin, centre.dir)).toBe(true);
    const centreAfter = throughWall(wallAfter, 8, 1.05);
    expect(rayHits(wallAfter, centreAfter.origin, centreAfter.dir)).toBe(false);
    const solid = throughWall(wallAfter, 7, 1.05);
    expect(rayHits(wallAfter, solid.origin, solid.dir)).toBe(true);

    // The body loses exactly the opening's share: 0.9 × 2.1 × 0.1 m.
    const lost = before.volumes.get(WALL)! - after.volumes.get(WALL)!;
    expect(lost).toBeCloseTo(0.9 * 2.1 * 0.1, 3);

    const doors = [...after.meshes.values()].flat().filter((m) => m.ifcType === 'IfcDoor');
    expect(doors.length).toBeGreaterThan(0);
  });
});
