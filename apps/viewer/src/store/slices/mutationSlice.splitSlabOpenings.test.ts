/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: splitting an authored slab must carry the physical cut to its
 * smaller piece, retaining the larger source identity and one Undo step. */
import '@/test/setup-dom.js';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { readHostedFill } from '@ifc-lite/create';
import { StepExporter } from '@ifc-lite/export';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { insideMesh, type Mesh } from '../../../../../packages/create/src/in-store/wall-join-mesh.oracle.js';
import { AnchorEntityReader } from '../../../../../packages/create/src/in-store/resolve-anchor.js';
import { refId } from '../../../../../packages/create/src/in-store/host-geometry-frame.js';
import { useViewerStore } from '@/store';
import { HUNG_SLAB, MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';

const wasmPath = fileURLToPath(new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const state = () => useViewerStore.getState();
const built = (result: { expressId: number } | { error: string }): number => {
  assert.ok('expressId' in result, 'error' in result ? result.error : '');
  return result.expressId;
};
function target() {
  const s = state(), store = s.models.get(MODEL_ID)?.ifcDataStore, view = s.mutationViews.get(MODEL_ID);
  assert.ok(store && view);
  return { store, view };
}
function exportText(): string {
  const { store, view } = target();
  return new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true,
    timeStamp: '2026-01-01T00:00:00' }).content);
}
function meshSlabs(text: string): Map<number, Mesh[]> {
  initSync({ module: readFileSync(wasmPath) });
  const api = new IfcAPI(), bytes = new TextEncoder().encode(text), result = new Map<number, Mesh[]>();
  try {
    const pre = api.buildPrePassOnce(bytes);
    const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, 0, 0, 0, false,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    try {
      for (let i = 0; i < collection.length; i++) {
        const mesh = collection.get(i);
        if (!mesh) continue;
        try {
          if (mesh.ifcType !== 'IfcSlab') continue;
          const positions = Float64Array.from(mesh.positions), origin = mesh.origin;
          for (let j = 0; j < positions.length; j++) positions[j] += origin[j % 3];
          const parts = result.get(mesh.expressId) ?? [];
          parts.push({ positions, indices: mesh.indices });
          result.set(mesh.expressId, parts);
        } finally { mesh.free(); }
      }
    } finally { collection.free(); }
  } finally { api.clearPrePassCache(); api.free(); }
  return result;
}
function batches(): number {
  const s = state();
  return new Set((s.undoStacks.get(MODEL_ID) ?? []).map(m => s.mutationBatchTags.get(m.id) ?? m.id)).size;
}
async function importAuthoredSource(): Promise<void> {
  const bytes = new TextEncoder().encode(exportText());
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const s = state(), model = s.models.get(MODEL_ID);
  assert.ok(model);
  useViewerStore.setState({ models: new Map([[MODEL_ID, { ...model, ifcDataStore: store }]]), ifcDataStore: store,
    mutationViews: new Map([[MODEL_ID, new MutablePropertyView(store.properties || null, MODEL_ID)]]),
    storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map() });
}
afterEach(() => state().exitModelWorkspace());

for (const unit of ['metre', 'millimetre'] as const) {
  it(`${unit}: a smaller slab piece retains the real opening cut and one Undo restores both hosts (#6232)`, async t => {
    if (!existsSync(wasmPath)) { t.skip('Run pnpm build:wasm for the physical slab opening oracle'); return; }
    await seedModelingSession({ unit, storeyOffset: [3, 3] });
    const slab = built(state().addSlab(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: 4, Depth: 3, Thickness: 0.2 }));
    const opening = built(state().addHostedFill(MODEL_ID, slab, { kind: 'opening', params: { Position: [0.5, 1.5], Width: 0.4, Depth: 0.6 } }));
    const other = built(state().addSlab(MODEL_ID, STOREY, { Position: [6, 0, 0], Width: 4, Depth: 3, Thickness: 0.2 }));
    const otherOpening = built(state().addHostedFill(MODEL_ID, other, { kind: 'opening', params: { Position: [0.5, 1.5], Width: 0.4, Depth: 0.6 } }));
    const authored = target(), sourceRead = readHostedFill(authored.store, opening, authored.view)!;
    const editor = state().storeEditors.get(MODEL_ID)!;
    const reader = new AnchorEntityReader(authored.store, authored.view);
    const otherPlacement = reader.entity(refId(reader.entity(otherOpening)!.attributes[5])!)!;
    editor.setPositionalAttribute(refId(otherPlacement.attributes[1])!, 0, `#${sourceRead.locationPointId}`);
    // Export then reparse: the two openings share an immutable SOURCE point.
    await importAuthoredSource();
    const { store, view } = target(), before = exportText(), original = meshSlabs(before);
    const originalRead = readHostedFill(store, opening, view)!;
    const sourcePoint = new AnchorEntityReader(store, view).entity(originalRead.locationPointId);
    const source = original.get(slab);
    assert.ok(source?.length, 'the original host has a real WASM mesh');
    assert.equal(insideMesh(source, [3.5, 0.1, -4.5]), false, 'the original slab is actually voided');
    assert.equal(insideMesh(source, [3.9, 0.1, -4.5]), true, 'beside the hole is solid material');
    const beforeBatches = batches();
    const split = state().splitSlabByLine(MODEL_ID, slab, [1, -1], [1, 4]);
    assert.ok(split.ok, split.ok ? '' : split.reason);
    if (!split.ok) return;
    const added = [split.left.expressId, split.right.expressId].find(id => id !== slab)!;
    const meshes = meshSlabs(exportText()), cut = meshes.get(added), kept = meshes.get(slab);
    assert.ok(cut?.length && kept?.length, 'both pieces have real WASM meshes');
    assert.equal(insideMesh(cut, [3.5, 0.1, -4.5]), false, 'the new smaller piece still contains the physical hole');
    assert.equal(insideMesh(cut, [3.9, 0.1, -4.5]), true, 'the new piece retains material beside its hole');
    assert.equal(insideMesh(kept, [5, 0.1, -4.5]), true, 'the larger source piece remains solid');
    assert.equal(readHostedFill(store, opening, view)?.hostId, added, 'the original opening identity follows its piece');
    assert.notEqual(readHostedFill(store, opening, view)?.locationPointId, originalRead.locationPointId);
    assert.deepEqual(new AnchorEntityReader(store, view).entity(originalRead.locationPointId), sourcePoint, 'the shared source point stays unchanged');
    assert.deepEqual(meshes.get(other), original.get(other), 'the second source host retains every mesh vertex and index');
    assert.equal(readHostedFill(store, otherOpening, view)?.hostId, other);
    assert.equal(batches(), beforeBatches + 1, 'the entire split is one Undo step');
    state().undo(MODEL_ID);
    assert.deepEqual(meshSlabs(exportText()).get(slab), source, 'one Undo restores every source mesh vertex and index');
    assert.equal(readHostedFill(store, opening, view)?.hostId, slab);
    assert.equal(view.getNewEntity(added), null, 'Undo removes the new piece');
    state().redo(MODEL_ID);
    assert.deepEqual(meshSlabs(exportText()).get(added), cut, 'one Redo restores the new voided host');
  });
}

it('many real slab cuts use the same bounded number of relation walks as one cut (#6232)', async () => {
  const measured: Array<{ voids: number; fills: number }> = [];
  for (const count of [1, 24]) {
    await seedModelingSession();
    const slab = built(state().addSlab(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: 4, Depth: 3, Thickness: 0.2 }));
    const openings = Array.from({ length: count }, (_, i) => built(state().addHostedFill(MODEL_ID, slab,
      { kind: 'opening', params: { Position: [0.5, 0.12 + i * 0.1], Width: 0.1, Depth: 0.05 } })));
    const walks = { voids: 0, fills: 0 }, original = AnchorEntityReader.prototype.ids;
    AnchorEntityReader.prototype.ids = function* (this: AnchorEntityReader, type: string) {
      if (type === 'IFCRELVOIDSELEMENT') walks.voids++;
      if (type === 'IFCRELFILLSELEMENT') walks.fills++;
      yield* original.call(this, type);
    };
    let split: ReturnType<ReturnType<typeof state>['splitSlabByLine']>;
    try { split = state().splitSlabByLine(MODEL_ID, slab, [1, -1], [1, 4]); }
    finally { AnchorEntityReader.prototype.ids = original; }
    assert.ok(split.ok, split.ok ? '' : split.reason);
    if (!split.ok) return;
    const added = [split.left.expressId, split.right.expressId].find(id => id !== slab)!;
    const { store, view } = target();
    for (const opening of openings) assert.equal(readHostedFill(store, opening, view)?.hostId, added);
    assert.ok(walks.voids > 0 && walks.fills > 0, 'count the actual canonical relationship reads');
    measured.push(walks);
  }
  assert.deepEqual(measured[1], measured[0], 'global relationship walks do not multiply by the number of cuts');
});

it('a crossing slab opening refuses before any graph or history writes (#6232)', async () => {
  await seedModelingSession();
  const slab = built(state().addSlab(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: 4, Depth: 3, Thickness: 0.2 }));
  built(state().addHostedFill(MODEL_ID, slab, { kind: 'opening', params: { Position: [1, 1.5], Width: 0.4, Depth: 0.6 } }));
  const before = exportText(), undo = state().undoStacks, redo = state().redoStacks;
  const split = state().splitSlabByLine(MODEL_ID, slab, [1, -1], [1, 4]);
  assert.ok(!split.ok && split.reason.includes('crosses a hosted opening'));
  assert.equal(exportText(), before);
  assert.deepEqual(state().undoStacks, undo); assert.deepEqual(state().redoStacks, redo);
});

it('a late unreadable filling rolls back the new slab, source profile, earlier move and history (#6232)', async () => {
  await seedModelingSession();
  const slab = built(state().addSlab(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: 4, Depth: 3, Thickness: 0.2 }));
  built(state().addHostedFill(MODEL_ID, slab, { kind: 'opening', params: { Position: [0.3, 1.5], Width: 0.15, Depth: 0.6 } }));
  const late = built(state().addHostedFill(MODEL_ID, slab, { kind: 'opening', params: { Position: [0.7, 1.5], Width: 0.15, Depth: 0.6 } }));
  const { store, view } = target(), editor = state().storeEditors.get(MODEL_ID)!;
  const reader = new AnchorEntityReader(store, view), parent = refId(reader.entity(late)!.attributes[5])!;
  const placement = editor.addEntity('IfcLocalPlacement', [`#${parent}`, null]).expressId;
  const filling = editor.addEntity('IfcDoor', ['2lateFilling00000000000', null, 'late', null, null, `#${placement}`, null, null, 2, 1, '.DOOR.', '.NOTDEFINED.', null]).expressId;
  editor.addEntity('IfcRelFillsElement', ['2lateRelation0000000000', null, null, null, `#${late}`, `#${filling}`]);
  const before = exportText(), entities = view.getNewEntities(), mutations = view.getMutations(), undo = state().undoStacks, redo = state().redoStacks;
  const split = state().splitSlabByLine(MODEL_ID, slab, [1, -1], [1, 4]);
  assert.ok(!split.ok && split.reason.includes('filling'));
  assert.equal(exportText(), before);
  assert.deepEqual(view.getNewEntities(), entities); assert.deepEqual(view.getMutations(), mutations);
  assert.deepEqual(state().undoStacks, undo); assert.deepEqual(state().redoStacks, redo);
});

for (const unit of ['metre', 'millimetre'] as const) {
  it(`${unit}: a carried opening in an imported downward extrusion retains its world Z (#6232)`, async t => {
    if (!existsSync(wasmPath)) { t.skip('Run pnpm build:wasm for the physical slab opening oracle'); return; }
    await seedModelingSession({ unit, storeyOffset: [3, 3] });
    const opening = built(state().addHostedFill(MODEL_ID, HUNG_SLAB, { kind: 'opening', params: { Position: [0.5, 1.5], Width: 0.4, Depth: 0.6 } }));
    const { store, view } = target(), original = readHostedFill(store, opening, view)!;
    const split = state().splitSlabByLine(MODEL_ID, HUNG_SLAB, [1, -1], [1, 4]);
    assert.ok(split.ok, split.ok ? '' : split.reason);
    if (!split.ok) return;
    const added = [split.left.expressId, split.right.expressId].find(id => id !== HUNG_SLAB)!;
    const moved = readHostedFill(store, opening, view)!;
    assert.ok(Math.abs(moved.sill - original.sill - 0.2) < 1e-9, 'source placement at 0.5m moves to the new body base at 0.3m');
    const mesh = meshSlabs(exportText()).get(added);
    assert.ok(mesh?.length);
    assert.equal(insideMesh(mesh, [3.5, 0.4, -4.5]), false);
    assert.equal(insideMesh(mesh, [3.9, 0.4, -4.5]), true);
  });
}

// #6232 / #6589: cosine-only frame checks admitted 1e-4 rad rotations and
// tilts. The plan reader adds only the element origin, so these real shapes
// must refuse before changing a cut's world placement or rewriting the slab.
for (const unit of ['metre', 'millimetre'] as const) for (const frame of ['placement rotation', 'placement tilt', 'solid tilt', 'extrusion tilt'] as const) {
  it(`${unit}: a real small ${frame} refuses slab split atomically (#6589)`, async t => {
    if (!existsSync(wasmPath)) { t.skip('Run pnpm build:wasm for the physical slab opening oracle'); return; }
    await seedModelingSession({ unit, storeyOffset: [3, 3] });
    const slab = built(state().addSlab(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: 4, Depth: 3, Thickness: 0.2 }));
    built(state().addHostedFill(MODEL_ID, slab, { kind: 'opening', params: { Position: [0.5, 1.5], Width: 0.4, Depth: 0.6 } }));
    const original = meshSlabs(exportText()).get(slab);
    assert.ok(original?.length);
    const { store, view } = target(), editor = state().storeEditors.get(MODEL_ID)!;
    const reader = new AnchorEntityReader(store, view);
    const element = reader.entity(slab)!;
    const placement = reader.entity(refId(element.attributes[5])!)!;
    const axis = refId(placement.attributes[1])!;
    const shape = reader.entity(refId(element.attributes[6])!)!;
    const rep = reader.entity(refId((shape.attributes[2] as unknown[])[0])!)!;
    const solidId = refId((rep.attributes[3] as unknown[])[0])!;
    const solid = reader.entity(solidId)!;
    const angle = 1e-4;
    const ratios = frame === 'placement rotation'
      ? [Math.cos(angle), Math.sin(angle), 0]
      : [Math.sin(angle), 0, Math.cos(angle)];
    const direction = editor.addEntity('IfcDirection', [ratios]).expressId;
    if (frame === 'placement rotation') editor.setPositionalAttribute(axis, 2, `#${direction}`);
    else if (frame === 'placement tilt') editor.setPositionalAttribute(axis, 1, `#${direction}`);
    else if (frame === 'solid tilt') editor.setPositionalAttribute(refId(solid.attributes[1])!, 1, `#${direction}`);
    else editor.setPositionalAttribute(solidId, 2, `#${direction}`);
    await importAuthoredSource();
    const before = exportText(), actual = meshSlabs(before).get(slab);
    assert.ok(actual?.length, 'the source has a real WASM mesh');
    assert.notDeepEqual(actual, original, 'the small orientation changes real world triangle positions');
    const undo = state().undoStacks, redo = state().redoStacks;
    const split = state().splitSlabByLine(MODEL_ID, slab, [1, -1], [1, 4]);
    assert.equal(split.ok, false, 'an unsupported orientation cannot carry a cut through an unrotated plan');
    assert.equal(exportText(), before, 'refusal leaves the entire IFC graph unchanged');
    assert.deepEqual(state().undoStacks, undo); assert.deepEqual(state().redoStacks, redo);
  });
}

for (const unit of ['metre', 'millimetre'] as const) {
  it(`${unit}: projected non-unit directions retain the physical cut through a slab split (#6589)`, async t => {
    if (!existsSync(wasmPath)) { t.skip('Run pnpm build:wasm for the physical slab opening oracle'); return; }
    await seedModelingSession({ unit, storeyOffset: [3, 3] });
    const slab = built(state().addSlab(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: 4, Depth: 3, Thickness: 0.2 }));
    built(state().addHostedFill(MODEL_ID, slab, { kind: 'opening', params: { Position: [0.5, 1.5], Width: 0.4, Depth: 0.6 } }));
    const original = meshSlabs(exportText()).get(slab);
    assert.ok(original?.length);
    const { store, view } = target(), editor = state().storeEditors.get(MODEL_ID)!;
    const reader = new AnchorEntityReader(store, view), element = reader.entity(slab)!;
    const placement = reader.entity(refId(element.attributes[5])!)!;
    const shape = reader.entity(refId(element.attributes[6])!)!;
    const rep = reader.entity(refId((shape.attributes[2] as unknown[])[0])!)!;
    const solidId = refId((rep.attributes[3] as unknown[])[0])!;
    const solid = reader.entity(solidId)!;
    const z = editor.addEntity('IfcDirection', [[0, 0, 3]]).expressId;
    const x = editor.addEntity('IfcDirection', [[2, 0, 1]]).expressId;
    for (const axis of [refId(placement.attributes[1])!, refId(solid.attributes[1])!]) {
      editor.setPositionalAttribute(axis, 1, `#${z}`);
      editor.setPositionalAttribute(axis, 2, `#${x}`);
    }
    editor.setPositionalAttribute(solidId, 2, `#${z}`);
    await importAuthoredSource();
    assert.deepEqual(meshSlabs(exportText()).get(slab), original, 'IFC projection removes the RefDirection component parallel to Axis');
    const split = state().splitSlabByLine(MODEL_ID, slab, [1, -1], [1, 4]);
    assert.ok(split.ok, split.ok ? '' : split.reason);
    if (!split.ok) return;
    const added = [split.left.expressId, split.right.expressId].find(id => id !== slab)!;
    const mesh = meshSlabs(exportText()).get(added);
    assert.ok(mesh?.length);
    assert.equal(insideMesh(mesh, [3.5, 0.1, -4.5]), false);
    assert.equal(insideMesh(mesh, [3.9, 0.1, -4.5]), true);
  });
}
