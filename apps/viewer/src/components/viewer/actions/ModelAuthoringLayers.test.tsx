/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { readFileSync, existsSync } from 'node:fs';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { render, click, cleanup } from '@/test/render';
import { GROUND_STOREY, SAMPLE_MODEL, seedAuthoringSample, parseIfc } from '@/test/authoring-sample-fixture';
import { applyMaterialLayers } from '@/components/viewer/model-inspector/inspector-edits';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { captureSelectionGrounding } from '@/lib/actions/selection-grounding';
import { parseModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { previewModelAuthoring } from '@/lib/actions/model-authoring-preview';
import { commitModelAuthoring } from '@/lib/actions/model-authoring-commit';
import { authoringGhosts } from '@/lib/actions/model-authoring-ghost';
import { layerSetOf } from '@/lib/commands/modeling/authored-kinds';
import { modelChangeLibrary } from '@/lib/actions/receipts';
import { ModelAuthoringReview } from './ModelAuthoringReview';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

async function targets(count = 1) {
  const { dataStore, view } = await seedAuthoringSample(), ids: number[] = [];
  const storeyId = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  for (let i = 0; i < count; i++) {
    const made = useViewerStore.getState().addWall(SAMPLE_MODEL, storeyId,
      { Start: [10 + i * 10, 10, 0], End: [14 + i * 10, 10, 0], Height: 3, Thickness: .2, Name: `Native review layer wall ${i}` });
    assert.ok('expressId' in made);
    ids.push(made.expressId);
    assert.ok(applyMaterialLayers(SAMPLE_MODEL, { kind: 'wall', target: 'element', elementId: made.expressId, typeId: null,
      layers: [{ thickness: .3, material: { name: `Current layer material ${i}` } }] }) !== null);
  }
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  const selection = captureSelectionGrounding({ ...useViewerStore.getState(), selectedEntityIds: new Set(ids) });
  assert.equal(selection.elements.length, count);
  for (const element of selection.elements) assert.ok(element.nativeLayers?.expected, '#7275 existing selection endpoint must supply complete native layer expectations');
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native layer review', units: 'm', frame: 'storey-local',
    operations: selection.elements.map((element, i) => ({ op: 'material.layers', scope: 'element',
      target: { globalId: element.globalId, modelId: element.modelId, ifcClass: element.type, name: element.name ?? '' },
      expected: element.nativeLayers?.expected, MaterialLayers: [{ LayerThickness: .5 + i * .1, Material: { create: { Name: `Approved layer material ${i}` } } }] })) }));
  for (const id of ids) assert.equal(parsed.entities.getName(id), `Native review layer wall ${ids.indexOf(id)}`);
  return { dataStore, view, ids, batch };
}

test('#7275 mounted layer review discloses coupled native wall effects and writes only explicitly approved rows', async () => {
  await modelChangeLibrary.initialize();
  const { dataStore, view, ids, batch } = await targets(2);
  const count = view.getMutationCount(), ui = render(<ModelAuthoringReview batch={batch} origin="native layer witness" />);
  assert.match(ui.textContent ?? '', /Assign material layers/);
  assert.match(ui.textContent ?? '', /Current layer material 0/);
  assert.match(ui.textContent ?? '', /resize its native body to the layer total/);
  assert.match(ui.textContent ?? '', /not an engineering check/);
  assert.equal(view.getMutationCount(), count, 'mounted native review publishes no draft before approval');
  const boxes = [...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  assert.equal(boxes.length, 2);
  act(() => boxes[1].click());
  const apply = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Apply 1 operation');
  assert.ok(apply);
  click(apply);
  assert.match(ui.textContent ?? '', /Applied 1 change/);
  const parsed = await parseIfc(editedModelBytes(dataStore, view)), parsedView = new MutablePropertyView(parsed.properties ?? null, SAMPLE_MODEL);
  assert.deepEqual(ids.map(id => layerSetOf({ dataStore: parsed, view: parsedView }, id)?.layers[0].thickness), [.5, .3]);
  assert.equal(parsed.entities.getName(layerSetOf({ dataStore: parsed, view: parsedView }, ids[0])!.layers[0].materialId!), 'Approved layer material 0');
});

test('#7275 mounted approval preserves distinct sub-millimetre layer thicknesses in declared units', async () => {
  const { dataStore, view, ids, batch } = await targets();
  const op = batch.operations[0];
  assert.equal(op.op, 'material.layers');
  if (op.op !== 'material.layers') throw new Error('Expected material.layers');
  op.MaterialLayers = [{ LayerThickness: .0004, Material: null }, { LayerThickness: .00045, Material: null }];
  const count = view.getMutationCount(), ui = render(<ModelAuthoringReview batch={batch} origin="thin layer witness" />);
  assert.match(ui.textContent ?? '', /0\.0004 m/);
  assert.match(ui.textContent ?? '', /0\.00045 m/);
  assert.equal(view.getMutationCount(), count);
  const apply = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Apply 1 operation');
  assert.ok(apply);
  click(apply);
  assert.match(ui.textContent ?? '', /Applied 1 change/);
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  const parsedView = new MutablePropertyView(parsed.properties ?? null, SAMPLE_MODEL);
  assert.deepEqual(layerSetOf({ dataStore: parsed, view: parsedView }, ids[0])?.layers.map(layer => layer.thickness), [.0004, .00045]);
});

function volume(positions: ArrayLike<number>, indices: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    sum += (positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
      - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
      + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])) / 6;
  }
  return Math.abs(sum);
}
const wasm = new URL('../../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
test('#7275 actual WASM exported wall thickness matches the native reviewed draft ghost',
  { skip: !existsSync(wasm) && 'run pnpm build:wasm:fetch' }, async () => {
    const { dataStore, view, ids, batch } = await targets();
    const lease = view.prepareAtomic(() => undefined), preview = previewModelAuthoring(useViewerStore.getState(), batch);
    assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? '');
    const ghosts = authoringGhosts(useViewerStore.getState(), preview);
    assert.equal(ghosts.length, 1);
    assert.doesNotThrow(lease.validate, 'native ghost generation publishes no model or allocator mutation');
    assert.ok(Math.abs(volume(ghosts[0].positions, ghosts[0].indices) - 6) < 1e-5, 'actual native draft ghost is the 4m×3m×.5m wall body');
    assert.ok(commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test').ok);
    const bytes = editedModelBytes(dataStore, view);
    initSync({ module: readFileSync(wasm) });
    const api = new IfcAPI();
    let solidVolume = 0;
    try {
      const pre = api.buildPrePassOnce(bytes);
      const [x, y, z] = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
      const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, x, y, z, pre.needsShift,
        pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
      try {
        for (let i = 0; i < collection.length; i++) {
          const mesh = collection.get(i);
          if (!mesh) continue;
          try { if (mesh.expressId === ids[0]) solidVolume += volume(mesh.positions, mesh.indices); }
          finally { mesh.free(); }
        }
      } finally { collection.free(); }
    } finally { api.clearPrePassCache(); api.free(); }
    assert.ok(Math.abs(solidVolume - 6) < 1e-5, `independent exported native WASM body has volume ${solidVolume}, expected 6 m³`);
  });
