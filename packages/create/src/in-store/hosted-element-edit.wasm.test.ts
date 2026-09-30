/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: ground truth for occurrence-only editing is the real WASM mesh of
 * the exported Bonsai model, including its voided host and other type instance. */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { editHostedElementInStore, readHostedElementSize } from './hosted-element-edit.js';
import { resolveHostAnchor } from './resolve-host.js';

const WASM = fileURLToPath(new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
interface MeshWitness { positions: number[]; indices: number[]; color: number[]; origin: number[] }

async function meshes(text: string) {
  const { IfcAPI, initSync } = await import('@ifc-lite/wasm');
  initSync({ module: readFileSync(WASM) });
  const api = new IfcAPI(), bytes = new TextEncoder().encode(text);
  try {
    api.setComputeGeometryHashes(1e-5);
    const pre = api.buildPrePassOnce(bytes);
    const [x, y, z] = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
    const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, x, y, z, pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    try {
      const volumes = new Map<number, number>(), shapes = new Map<number, MeshWitness[]>();
      const ids = collection.geometryHashIds, values = collection.geometryVolumeValues;
      for (let i = 0; i < ids.length; i++) volumes.set(ids[i], values[i]);
      for (let i = 0; i < collection.length; i++) {
        const mesh = collection.get(i);
        if (!mesh) continue;
        try {
          const list = shapes.get(mesh.expressId) ?? [];
          list.push({ positions: Array.from(mesh.positions), indices: Array.from(mesh.indices), color: Array.from(mesh.color), origin: Array.from(mesh.origin) });
          shapes.set(mesh.expressId, list);
        } finally { mesh.free(); }
      }
      return { volumes, shapes };
    } finally { collection.free(); }
  } finally { api.clearPrePassCache(); api.free(); }
}

function bounds(parts: MeshWitness[]) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of parts) for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = mesh.positions[i + axis] + mesh.origin[axis];
      min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}

describe('hosted occurrence real WASM oracle (#6232)', () => {
  it.skipIf(!existsSync(WASM))('rescales only the selected mapped window and enlarges its real void (build WASM to run)', async () => {
    const bytes = readFileSync(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
    const text = bytes.toString('utf8');
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
    const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
    const oldSize = readHostedElementSize(store, 1262, view)!;
    const before = await meshes(text);
    const host = resolveHostAnchor(store, 1222, view).hostBounds!;
    editHostedElementInStore(store, editor, 1262, { OverallWidth: 1.2, OverallHeight: 1.4 });
    const updated = new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content);
    const after = await meshes(updated);
    expect(before.shapes.get(1262)?.length).toBeGreaterThan(0);
    expect(after.shapes.get(1262)?.length).toBe(before.shapes.get(1262)?.length);
    const oldParts = before.shapes.get(1262)!, newParts = after.shapes.get(1262)!;
    const oldBox = bounds(oldParts), nextBox = bounds(newParts);
    const centre = (oldBox.min[0] + oldBox.max[0]) / 2;
    expect(nextBox.max[0] - nextBox.min[0]).toBeCloseTo(1.2, 5);
    expect(nextBox.max[1] - nextBox.min[1]).toBeCloseTo(1.4, 5); // Mesh coordinates are viewer Y-up.
    // Physical anchoring is independent of mesh vertex/part ordering. The
    // selected opening's centre and sill must stay in the same world frame.
    expect(nextBox.min[0]).toBeCloseTo(centre - 0.6, 5);
    expect(nextBox.max[0]).toBeCloseTo(centre + 0.6, 5);
    expect(nextBox.min[1]).toBeCloseTo(oldBox.min[1], 5);
    expect(nextBox.min[2]).toBeCloseTo(oldBox.min[2], 5);
    expect(nextBox.max[2]).toBeCloseTo(oldBox.max[2], 5);
    for (let part = 0; part < oldParts.length; part++) {
      expect(newParts[part].indices).toEqual(oldParts[part].indices);
      expect(newParts[part].color).toEqual(oldParts[part].color);
      for (let i = 0; i < oldParts[part].positions.length; i += 3) {
        const p = oldParts[part].positions.slice(i, i + 3).map((v, axis) => v + oldParts[part].origin[axis]);
        const actual = newParts[part].positions.slice(i, i + 3).map((v, axis) => v + newParts[part].origin[axis]);
        expect(actual[0]).toBeCloseTo(centre + (p[0] - centre) * 1.2 / oldSize.OverallWidth, 5);
        expect(actual[1]).toBeCloseTo(oldBox.min[1] + (p[1] - oldBox.min[1]) * 1.4 / oldSize.OverallHeight, 5);
        expect(actual[2]).toBeCloseTo(p[2], 5);
      }
    }
    // A source window consists of multiple representation items: its native
    // volume is deliberately NaN, so vertices/topology provide the oracle.
    // The source opening matches the window size. The changed cut removes
    // the additional opening area through the actual wall thickness.
    const lost = (1.2 * 1.4 - oldSize.OverallWidth * oldSize.OverallHeight) * (host.max[1] - host.min[1]);
    expect(before.volumes.get(1222)! - after.volumes.get(1222)!).toBeCloseTo(lost, 5);
    expect(after.shapes.get(1407)).toEqual(before.shapes.get(1407));
    expect(after.volumes.get(1407)).toBe(before.volumes.get(1407));
    for (const [id, shape] of before.shapes) {
      if (id !== 1222 && id !== 1262) expect(after.shapes.get(id), `unrelated occurrence #${id} stays byte-identical`).toEqual(shape);
    }
  });
});
