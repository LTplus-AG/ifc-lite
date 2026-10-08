/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
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

test('#7215 concave polygon and sloped/near-vertical hollow section ghosts match actual native WASM exported volumes', { skip: !existsSync(wasm) && 'run pnpm build:wasm:fetch' }, async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const operations = [
    { ifcClass: 'IfcSlab', params: { Profile: 'polygon', OuterCurve: [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]], thickness: .2 } },
    { ifcClass: 'IfcBeam', params: { start: [0, 0, 3], end: [4, 0, 4], Profile: { Type: 'RectangleHollow', XDim: .4, YDim: .3, WallThickness: .02 } } },
    { ifcClass: 'IfcMember', params: { start: [0, 0, 0], end: [.1, .1, 4], Profile: { Type: 'L', Width: .2, Depth: .3, Thickness: .02 } } },
  ].map((op, i) => ({ ...op, op: 'element.create', ref: `native-${i}`, storey: { globalId: GROUND_STOREY }, name: `Native geometry ${i}` }));
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native geometry', units: 'm', frame: 'storey-local', operations }));
  const preview = previewModelAuthoring(useViewerStore.getState(), batch);
  assert.deepEqual(preview.rows.map((row) => row.status), ['ready', 'ready', 'ready']);
  const ghosts = authoringGhosts(useViewerStore.getState(), preview);
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0, 1, 2]), 'WASM native');
  assert.ok(outcome.ok);
  const bytes = editedModelBytes(dataStore, view), reparsed = await parseIfc(bytes);
  const ids = outcome.receipt.applied.map((row) => reparsed.entities.getExpressIdByGlobalId(row.globalId));
  initSync({ module: readFileSync(wasm) });
  const api = new IfcAPI(), pre = api.buildPrePassOnce(bytes);
  const volumes = new Map<number, number>();
  try {
    const [x, y, z] = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
    const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, x, y, z, pre.needsShift, pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    try {
      for (let i = 0; i < collection.length; i++) {
        const mesh = collection.get(i);
        if (!mesh) continue;
        try { if (ids.includes(mesh.expressId)) volumes.set(mesh.expressId, (volumes.get(mesh.expressId) ?? 0) + volume({ positions: mesh.positions, indices: mesh.indices })); }
        finally { mesh.free(); }
      }
    } finally { collection.free(); }
  } finally { api.clearPrePassCache(); api.free(); }
  for (const [i, id] of ids.entries()) {
    const native = volumes.get(id) ?? 0, ghost = volume(ghosts[i]);
    assert.ok(native > 0 && ghost > 0, 'both native exported solid and actual ghost enclose positive volume');
    assert.ok(Math.abs(native - ghost) / native < .002, `shape ${i} actual WASM ${native} agrees with ghost ${ghost}`);
  }
});
