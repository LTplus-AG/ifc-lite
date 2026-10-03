/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { StepExporter } from '@ifc-lite/export';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { configureMutationView } from '@/utils/configureMutationView';

const wasmPath = resolve(import.meta.dirname, '../../../../packages/wasm/pkg/ifc-lite_bg.wasm');
let initialized = false;
export function envelopeWasm(t: TestContext): boolean {
  if (!existsSync(wasmPath)) { t.skip('WASM absent: run pnpm build:wasm:fetch'); return false; }
  if (!initialized) { initSync({ module: readFileSync(wasmPath) }); initialized = true; }
  return true;
}

export async function exportEnvelope(modelId: string) {
  const s = useViewerStore.getState(), store = s.models.get(modelId)!.ifcDataStore!, view = s.mutationViews.get(modelId)!;
  const { content } = new StepExporter(store, view).export({ schema: store.schemaVersion === 'IFC2X3' ? 'IFC2X3' : 'IFC4', applyMutations: true });
  const text = new TextDecoder().decode(content);
  const parsed = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer, { disableWorkerScan: true });
  const reopened = new MutablePropertyView(parsed.properties ?? null, 'reopened');
  configureMutationView(reopened, parsed);
  return { text, parsed, view: reopened, editor: new StoreEditor(parsed, reopened) };
}

/** Real wasm meshes, signed tetrahedron volume and world-IFC vertex bounds.
 * Handles are freed even if an assertion in a caller subsequently fails. */
export function envelopeMesh(text: string, expressId: number) {
  const api = new IfcAPI(), bytes = new TextEncoder().encode(text);
  try {
    const pre = api.buildPrePassOnce(bytes);
    const [x, y, z] = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
    const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, x, y, z, pre.needsShift, pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    try {
      const points: number[][] = [];
      const colors: number[][] = [];
      let volume = 0;
      for (let i = 0; i < collection.length; i++) {
        const mesh = collection.get(i);
        if (!mesh) continue;
        try {
          if (mesh.expressId !== expressId) continue;
          colors.push(Array.from(mesh.color));
          const positions = mesh.positions, indices = mesh.indices, o = mesh.origin;
          for (let j = 0; j < positions.length; j += 3) points.push([o[0] + positions[j], -(o[2] + positions[j + 2]), o[1] + positions[j + 1]]);
          for (let j = 0; j < indices.length; j += 3) {
            const a = indices[j] * 3, b = indices[j + 1] * 3, c = indices[j + 2] * 3;
            // Translation-invariant for a closed mesh, so per-mesh relative positions suffice.
            volume += (positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
              - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
              + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])) / 6;
          }
        } finally { mesh.free(); }
      }
      return { points, colors, volume: Math.abs(volume), minZ: Math.min(...points.map(p => p[2])), maxZ: Math.max(...points.map(p => p[2])) };
    } finally { collection.free(); }
  } finally {
    try { api.clearPrePassCache(); } finally { api.free(); }
  }
}
