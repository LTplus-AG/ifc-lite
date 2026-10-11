/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { getAttributeNamesForSchema } from '@ifc-lite/parser';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { GROUND_STOREY, seedAuthoringSample, parseIfc } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { authoringGhosts } from './model-authoring-ghost';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
const wasm = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);

function volume(mesh: Pick<MeshData, 'positions' | 'indices'>): number {
  const p = mesh.positions, ids = mesh.indices;
  let sum = 0;
  for (let i = 0; i < ids.length; i += 3) {
    const a = ids[i] * 3, b = ids[i + 1] * 3, c = ids[i + 2] * 3;
    sum += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return Math.abs(sum);
}

test('#7215 native WASM verifies exact footprint/section ghosts and the disclosed optional-fillet approximation', { skip: !existsSync(wasm) && 'run pnpm build:wasm:fetch' }, async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const operations = [
    { ifcClass: 'IfcSlab', params: { Profile: 'polygon', OuterCurve: [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]], thickness: .2 } },
    { ifcClass: 'IfcBeam', params: { start: [0, 0, 3], end: [4, 0, 4], Profile: { Type: 'RectangleHollow', XDim: .4, YDim: .3, WallThickness: .02 } } },
    { ifcClass: 'IfcBeam', params: { start: [0, 0, 3], end: [4, 0, 4], width: .4, height: .3 } },
    { ifcClass: 'IfcBeam', params: { start: [0, 0, 3], end: [4, 0, 3], Profile: { Type: 'I', OverallWidth: .2, OverallDepth: .4, WebThickness: .01, FlangeThickness: .03, FilletRadius: .025 } } },
    { ifcClass: 'IfcMember', params: { start: [0, 0, 0], end: [.1, .1, 4], Profile: { Type: 'L', Width: .2, Depth: .3, Thickness: .02 } } },
  ].map((op, i) => ({ ...op, op: 'element.create', ref: `native-${i}`, storey: { globalId: GROUND_STOREY }, name: `Native geometry ${i}` }));
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native geometry', units: 'm', frame: 'storey-local', operations }));
  const preview = previewModelAuthoring(useViewerStore.getState(), batch);
  assert.deepEqual(preview.rows.map((row) => row.status), operations.map(() => 'ready'));
  const ghosts = authoringGhosts(useViewerStore.getState(), preview);
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set(preview.rows.map((row) => row.index)), 'WASM native');
  assert.ok(outcome.ok);
  const bytes = editedModelBytes(dataStore, view), reparsed = await parseIfc(bytes);
  const fillet = [...reparsed.entityIndex.byId.values()].find((row) => row.type === 'IFCISHAPEPROFILEDEF')!;
  assert.equal(reparsed.getEntity(fillet.expressId)?.attributes[getAttributeNamesForSchema('IfcIShapeProfileDef', reparsed.schemaVersion).indexOf('FilletRadius')], 25, 'independent native export preserves declared fillet in source millimetres');
  const ids = outcome.receipt.applied.map((row) => reparsed.entities.getExpressIdByGlobalId(row.globalId));
  initSync({ module: readFileSync(wasm) });
  const api = new IfcAPI();
  const volumes = new Map<number, number>();
  const bounds = new Map<number, { min: number[]; max: number[] }>();
  try {
    const pre = api.buildPrePassOnce(bytes);
    const [x, y, z] = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
    const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, x, y, z, pre.needsShift, pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    try {
      for (let i = 0; i < collection.length; i++) {
        const mesh = collection.get(i);
        if (!mesh) continue;
        try { if (ids.includes(mesh.expressId)) {
          const positions = mesh.positions, origin = mesh.origin;
          volumes.set(mesh.expressId, (volumes.get(mesh.expressId) ?? 0) + volume({ positions, indices: mesh.indices }));
          const box = bounds.get(mesh.expressId) ?? { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
          for (let at = 0; at < positions.length; at += 3) for (let axis = 0; axis < 3; axis++) {
            const coordinate = positions[at + axis] + origin[axis];
            box.min[axis] = Math.min(box.min[axis], coordinate); box.max[axis] = Math.max(box.max[axis], coordinate);
          }
          bounds.set(mesh.expressId, box);
        } }
        finally { mesh.free(); }
      }
    } finally { collection.free(); }
  } finally { api.clearPrePassCache(); api.free(); }
  for (const [i, id] of ids.entries()) {
    const native = volumes.get(id) ?? 0, ghost = volume(ghosts[i]);
    assert.ok(native > 0 && ghost > 0, 'both native exported solid and actual ghost enclose positive volume');
    const box = bounds.get(id)!;
    for (let axis = 0; axis < 3; axis++) {
      const coordinates = Array.from(ghosts[i].positions).filter((_v, at) => at % 3 === axis);
      assert.ok(Math.abs(Math.min(...coordinates) - box.min[axis]) < .001 && Math.abs(Math.max(...coordinates) - box.max[axis]) < .001, `shape ${i} native and ghost bounds agree on render axis ${axis}`);
    }
    if (i === 3) assert.ok(native > ghost * 1.02 && native < ghost * 1.05, 'native positive fillet changes the solid while the disclosed canonical ghost retains sharp corners');
    else assert.ok(Math.abs(native - ghost) / native < .002, `shape ${i} actual WASM ${native} agrees with ghost ${ghost}`);
  }
});
