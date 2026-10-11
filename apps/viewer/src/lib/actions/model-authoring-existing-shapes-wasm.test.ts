/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { readAuthoringSize } from './model-authoring-size';
import { readElementProfile } from '@/store/slices/mutation-element-profile';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { GROUND_STOREY, SAMPLE_MODEL, seedAuthoringSample, parseIfc } from '@/test/authoring-sample-fixture';
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

test('#7229 native WASM verifies edited source geometry against resize/profile ghosts', { skip: !existsSync(wasm) && 'run pnpm build:wasm:fetch' }, async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const creations = [
    { ifcClass: 'IfcSlab', params: { Profile: 'polygon', OuterCurve: [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]], thickness: .2 } },
    { ifcClass: 'IfcBeam', params: { start: [0, 0, 3], end: [4, 3, 4], Profile: { Type: 'RectangleHollow', XDim: .4, YDim: .3, WallThickness: .02 } } },
    { ifcClass: 'IfcBeam', params: { start: [10, 0, 3], end: [13, 4, 5], width: .4, height: .3 } },
    { ifcClass: 'IfcMember', params: { start: [0, 0, 0], end: [.1, .1, 4], Profile: { Type: 'L', Width: .2, Depth: .3, Thickness: .02 } } },
  ].map((operation, index) => ({ ...operation, op: 'element.create', ref: `native-edit-${index}`, storey: { globalId: GROUND_STOREY }, name: `Native edit ${index}` }));
  const batch = (operations: unknown[]) => parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native geometry edits', units: 'm', frame: 'storey-local', operations }));
  const creationPreview = previewModelAuthoring(useViewerStore.getState(), batch(creations));
  const created = commitModelAuthoring(useViewerStore, creationPreview, new Set(creations.map((_, index) => index)), 'native geometry targets');
  assert.ok(created.ok, created.ok ? '' : created.detail ?? created.reason);
  const before = await parseIfc(editedModelBytes(dataStore, view));
  const state = useViewerStore.getState(), model = state.models.get(SAMPLE_MODEL)!;
  const readState = { ...state, models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: before }]]), mutationViews: new Map([[SAMPLE_MODEL, new MutablePropertyView(before.properties, SAMPLE_MODEL)]]), storeEditors: new Map() };
  const operations = created.receipt.applied.map((target, index) => {
    const id = before.entities.getExpressIdByGlobalId(target.globalId);
    const identity = { globalId: target.globalId, ifcClass: target.field, name: before.entities.getName(id) };
    if (index === 3) return { op: 'element.profile', target: identity, expected: readElementProfile(readState, SAMPLE_MODEL, id),
      Profile: { Type: 'RectangleHollow', XDim: .4, YDim: .3, WallThickness: .02 } };
    return { op: 'element.resize', target: identity, expected: readAuthoringSize(readState, SAMPLE_MODEL, id, index === 0 ? 'slab' : 'linear'),
      size: index === 0 ? { kind: 'slab', thickness: .4 } : index === 1 ? { kind: 'linear', length: 6, fixed: 'end' }
        : { kind: 'linear', length: 6, width: .5, cross: .4, fixed: 'end' } };
  });
  const preview = previewModelAuthoring(useViewerStore.getState(), batch(operations));
  assert.deepEqual(preview.rows.map(row => [row.status, row.issue]), operations.map(() => ['ready', undefined]));
  const count = view.getMutationCount();
  const ghosts = authoringGhosts(useViewerStore.getState(), preview);
  assert.equal(ghosts.length, 4, 'native source edits have an actual complete bounded ghost');
  assert.equal(view.getMutationCount(), count, 'geometry preview never publishes the native draft');
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set(preview.rows.map(row => row.index)), 'native geometry edits');
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  const bytes = editedModelBytes(dataStore, view), reparsed = await parseIfc(bytes);
  const ids = created.receipt.applied.map(row => reparsed.entities.getExpressIdByGlobalId(row.globalId));
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
    assert.ok(Math.abs(native - ghost) / native < .002, `shape ${i} actual WASM ${native} agrees with ghost ${ghost}`);
  }
});
