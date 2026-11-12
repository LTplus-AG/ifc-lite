/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { it, afterEach, type TestContext } from 'node:test';
import { act } from 'react';
import { StepExporter } from '@ifc-lite/export';
import { IfcParser, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { IfcAPI } from '@ifc-lite/wasm';
import { AnchorEntityReader } from '../../../../../packages/create/src/in-store/resolve-anchor.js';
import { asRef, refList } from '../../../../../packages/create/src/in-store/style-entity-reader.js';
import { remeshOnApi, styleWireOnApi } from '../../../../../packages/geometry/src/remesh/remesh-core.js';
import { useViewerStore } from '@/store';
import { seedModelingSession, MODEL_ID } from '@/test/modeling-session-fixture';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { configureMutationView } from '@/utils/configureMutationView';
import { ensureSpaceWasm } from '@/lib/rooms/space-wasm';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { render, cleanup, click, type as typeInto } from '@/test/render';
import { GeometryEditCard } from '@/components/viewer/GeometryEditCard';
import { createStoreAdapter } from './store-adapter';
import { loadStoreyAdapter } from './store-adapter-storey';

const fixture = new URL('../../../../../tests/models/modelling/saved-building.ifc', import.meta.url);
// Saved IFC4: five walls, two hosted fillings, a slab, two generated spaces and
// two storeys. The type's layer total is 0.23 m; actual wall bodies are 0.20 m.
const perimeter = [64, 85, 120, 155], partition = 205, rooms = [319, 337];
const M = MODEL_ID;

afterEach(() => { cleanup(); act(() => useViewerStore.getState().exitModelWorkspace()); });

async function reopen(t: TestContext) {
  if (!existsSync(fixture)) { t.skip('Run pnpm fixtures modelling/saved-building.ifc'); return false; }
  if (!ensureRoomWasm(t)) return false;
  await seedModelingSession({ step: readFileSync(fixture, 'utf8') });
  const s = useViewerStore.getState();
  configureMutationView(s.mutationViews.get(M)!, s.models.get(M)!.ifcDataStore!);
  await ensureSpaceWasm();
  return true;
}

function save() {
  const s = useViewerStore.getState();
  return new StepExporter(s.models.get(M)!.ifcDataStore!, s.mutationViews.get(M)!)
    .export({ schema: 'IFC4', applyMutations: true }).content;
}

function movePartition() {
  const before = useViewerStore.getState().readEntityPosition(M, partition)!;
  assert.ok(before);
  const ui = render(<GeometryEditCard modelId={M} entityId={partition} />);
  const x = ui.querySelector<HTMLInputElement>('input[type="number"]'); assert.ok(x);
  typeInto(x, String(before[0] + 1));
  const apply = [...ui.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Apply XYZ'); assert.ok(apply);
  click(apply);
  assert.ok(Math.abs(useViewerStore.getState().readEntityPosition(M, partition)![0] - before[0] - 1) < 1e-8);
  return before;
}

async function readSaved(content: Uint8Array) {
  return new IfcParser().parseColumnar(content.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
}

function floorAreas(data: Awaited<ReturnType<typeof readSaved>>) {
  return rooms.map(id => {
    const q = extractQuantitiesOnDemand(data, id).find(set => set.name === 'Qto_SpaceBaseQuantities');
    const area = q?.quantities.find(quantity => quantity.name === 'NetFloorArea')?.value;
    assert.equal(typeof area, 'number'); return Number(area);
  });
}

function meshFloorAreas(content: Uint8Array) {
  const api = new IfcAPI();
  try {
    const result = remeshOnApi(api, { ...styleWireOnApi(api, content), buffer: content,
      targets: Uint32Array.from(rooms), frame: { x: 0, y: 0, z: 0, needsShift: false } });
    return rooms.map(id => {
      const meshes = result.meshes.filter(mesh => mesh.expressId === id); assert.ok(meshes.length);
      const top = Math.max(...meshes.flatMap(mesh => Array.from(mesh.positions).filter((_, i) => i % 3 === 1)));
      let area = 0;
      for (const mesh of meshes) for (let i = 0; i < mesh.indices.length; i += 3) {
        const [a, b, c] = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]]
          .map(index => mesh.positions.slice(index * 3, index * 3 + 3));
        if ([a, b, c].every(p => Math.abs(p[1] - top) < 1e-5)) {
          area += Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) / 2;
        }
      }
      return area;
    });
  } finally { api.free(); }
}

it('#9296 saved building: move and two storey copies retain every definition and type occurrence', async t => {
  if (!await reopen(t)) return;
  await loadStoreyAdapter();
  const restore = setRequestRemesh(() => {});
  try {
    movePartition();
    const moved = save();
    cleanup();
    // A further fresh parse catches references shared between source and overlay.
    await seedModelingSession({ step: new TextDecoder().decode(moved) });
    const s = useViewerStore.getState();
    configureMutationView(s.mutationViews.get(M)!, s.models.get(M)!.ifcDataStore!);
    const adapter = createStoreAdapter(useViewerStore);
    const third = adapter.addStorey!(M, { Name: 'Level 3', Elevation: 6 });
    const first = adapter.copyElements!(M, perimeter, [{ targetStoreyId: 36 }]);
    const second = adapter.copyElements!(M, first.map(result => result.expressId), [{ targetStoreyId: third.expressId }]);
    const output = save(), data = await readSaved(output), reader = new AnchorEntityReader(data, null);
    const properties = [...reader.ids('IFCRELDEFINESBYPROPERTIES')]; assert.ok(properties.length > 0);
    for (const id of properties) {
      const definition = asRef(reader.entity(id)!.attributes[5]);
      assert.ok(definition && reader.entity(definition), `Property relationship #${id} has a definition`);
    }
    const rels = [...reader.ids('IFCRELDEFINESBYTYPE')].map(id => reader.entity(id)!);
    const types = [...reader.ids('IFCWALLTYPE')]; assert.equal(types.length, 1);
    for (const id of types) {
      const own = rels.filter(rel => asRef(rel.attributes[5]) === id);
      assert.equal(own.length, 1, 'one relationship per saved wall type');
      assert.deepEqual(refList(own[0].attributes[4]).sort((a, b) => a - b),
        [...reader.ids('IFCWALL')].sort((a, b) => a - b), 'every original and copied wall is covered');
    }
    for (const [type, count] of [['IFCWALL', 13], ['IFCDOOR', 3], ['IFCWINDOW', 3], ['IFCOPENINGELEMENT', 6], ['IFCSLAB', 1], ['IFCSPACE', 2]] as const) {
      assert.equal([...reader.ids(type)].length, count);
    }
    const quantities = (id: number) => extractQuantitiesOnDemand(data, id).find(set => set.name === 'Qto_WallBaseQuantities')?.quantities;
    for (let i = 0; i < perimeter.length; i++) {
      const original = quantities(perimeter[i]); assert.ok(original?.length);
      assert.deepEqual(quantities(first[i].expressId), original);
      assert.deepEqual(quantities(second[i].expressId), original);
    }
  } finally { restore(); }
});

it('#9296 saved building: inspector move updates room geometry and quantities with one undo', async t => {
  if (!await reopen(t)) return;
  const restore = setRequestRemesh(() => {});
  try {
    const beforeBytes = save(), before = await readSaved(beforeBytes), areas = floorAreas(before);
    const guids = rooms.map(id => before.entities.getGlobalId(id));
    const position = movePartition();
    const movedBytes = save(), moved = await readSaved(movedBytes), after = floorAreas(moved);
    // The interior partition spans 7.8 m between the 0.20 m perimeter bodies.
    const meshed = meshFloorAreas(movedBytes);
    for (let i = 0; i < rooms.length; i++) {
      assert.equal(moved.entities.getGlobalId(rooms[i]), guids[i]);
      assert.ok(Math.abs(after[i] - areas[i] - (i === 0 ? 7.8 : -7.8)) < 1e-4);
      assert.ok(Math.abs(meshed[i] - after[i]) < 1e-4);
    }
    act(() => useViewerStore.getState().undo(M));
    assert.deepEqual(useViewerStore.getState().readEntityPosition(M, partition), position);
    const undone = save();
    assert.deepEqual(floorAreas(await readSaved(undone)), areas);
    meshFloorAreas(undone).forEach((area, i) => assert.ok(Math.abs(area - areas[i]) < 1e-4));
    act(() => useViewerStore.getState().redo(M));
    assert.deepEqual(floorAreas(await readSaved(save())), after);
  } finally { restore(); }
});
