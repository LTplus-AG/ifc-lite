/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcTypeEnum } from '@ifc-lite/data';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { cleanup, click, render } from '@/test/render';
import { envelopeWasm, envelopeMesh, exportEnvelope } from '@/test/space-envelope-oracle';
import { readSpaceEnvelope } from '@/lib/rooms/space-envelope-read';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { envelopeMeasures, sectionEnvelope } from '@/lib/rooms/space-envelope';
import { SpaceEnvelopeBar } from '@/components/viewer/tools/command/SpaceEnvelopeHud';
import { setRequestRemesh, runTransaction, type RemeshRequest } from '../transaction';
import { getModelingCommand } from '../registry';
import { getCommandRuntime, updateCommandGesture, commitCommand, commandPointerDown, commandPointerMove } from '../runtime';
import { SPACE_ENVELOPE, setEnvelopeMode, type SpaceEnvelopeGesture } from './space-envelope';
import '../builtin';

const s = () => useViewerStore.getState();
const gesture = () => getCommandRuntime().gesture as SpaceEnvelopeGesture;
const context = () => getCommandRuntime().ctx!;
const made = (r: { expressId: number } | { error: string }) => { assert.ok('expressId' in r, 'error' in r ? r.error : ''); return r.expressId; };
const select = (id: number, modelId = MODEL_ID) => s().setSelectedEntityId(toGlobalIdFromModels(s().models, modelId, id));
const start = (id: number) => { select(id); s().startCommand('space.envelope'); assert.ok(gesture().target); };
const room = () => made(s().addSpace(MODEL_ID, STOREY, { Profile: 'polygon', OuterCurve: [[0, 0], [4, 0], [4, 3], [0, 3]], Position: [0, 0, 0], Height: 3, Name: 'Envelope room' }));
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-4, `${a} != ${b}`);
const read = (id: number) => readSpaceEnvelope(modelEditTarget(s(), MODEL_ID)!, id)!;
const at = (u: number, z: number) => ({ local: [u, z] as const, winner: null, guides: [], locked: false, metresPerPixel: 0.01 });
let restore: () => void;
let remeshes: RemeshRequest[];
beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.setState({ sectionPlane: { ...s().sectionPlane, enabled: false, custom: undefined, box: undefined } });
  remeshes = [];
  restore = setRequestRemesh((_get, request) => remeshes.push(request));
});
afterEach(() => { restore(); cleanup(); s().exitModelWorkspace(); });

function apply(mode: 'slope' | 'pitched', left: number, right: number, ridge = 4, floor = 0) {
  const g = setEnvelopeMode(gesture(), mode);
  const points = g.points.map((p, i) => [p[0], i === 0 ? left : i === g.points.length - 1 ? right : ridge] as const);
  act(() => updateCommandGesture(() => ({ ...g, points, floor })));
  assert.equal(commitCommand(), true);
}

describe('space envelope editing (#6686)', () => {
  for (const mode of ['slope', 'pitched'] as const) {
    it(`${mode} survives save/reload with its actual wasm volume, identity and one-step undo`, async t => {
      if (!envelopeWasm(t)) return;
      const id = room(), before = read(id);
      const globalId = s().storeEditors.get(MODEL_ID)!.getNewEntity(id)!.attributes[0];
      start(id); apply(mode, 2, mode === 'slope' ? 4 : 2);
      const edited = read(id), expectedVolume = 36;
      near(envelopeMeasures(edited.chain.footprint, edited.envelope)!.volume, expectedVolume);
      assert.equal(edited.storeyId, before.storeyId);
      assert.equal(remeshes.length, 1);
      assert.deepEqual(remeshes[0].expressIds, [id]);
      const exported = await exportEnvelope(MODEL_ID);
      const parsedId = exported.parsed.entities.getByType(IfcTypeEnum.IfcSpace)[0];
      const saved = readSpaceEnvelope({ modelId: 'reopened', dataStore: exported.parsed, view: exported.view, editor: exported.editor }, parsedId)!;
      assert.ok(saved, 'saved clipped envelope is editable');
      near(envelopeMeasures(saved.chain.footprint, saved.envelope)!.volume, expectedVolume);
      assert.equal(exported.parsed.entities.getGlobalId(parsedId), globalId);
      const mesh = envelopeMesh(exported.text, parsedId);
      near(mesh.volume, expectedVolume); near(mesh.minZ, 0); near(mesh.maxZ, 4);
      assert.ok(mesh.points.some(p => Math.abs(p[2] - 2) < 1e-4));
      near(exported.view.getQuantitiesForEntity(parsedId).flatMap(q => q.quantities).find(q => q.name === 'GrossVolume')!.value, expectedVolume);
      s().undo(MODEL_ID);
      near(envelopeMeasures(read(id).chain.footprint, read(id).envelope)!.volume, 36);
      assert.equal(read(id).envelope.ceiling.length, 1);
      assert.equal(read(id).envelope.ceiling[0].a, 0);
      s().redo(MODEL_ID);
      near(envelopeMeasures(read(id).chain.footprint, read(id).envelope)!.volume, expectedVolume);
      assert.equal(read(id).envelope.ceiling.length, mode === 'slope' ? 1 : 2);
    });
  }

  it('a click-move-click floor gesture commits once; Escape writes nothing', () => {
    const id = room(); start(id);
    const before = s().mutationViews.get(MODEL_ID)!.getMutations().length;
    const p = [(gesture().points[0][0] + gesture().points[1][0]) / 2, 0];
    commandPointerDown(at(p[0], p[1]));
    commandPointerMove(at(p[0], 0.5));
    s().endCommand('cancel');
    assert.equal(s().mutationViews.get(MODEL_ID)!.getMutations().length, before);
    start(id);
    commandPointerDown(at(p[0], 0)); commandPointerMove(at(p[0], 0.5)); commandPointerDown(at(p[0], 0.5));
    near(read(id).envelope.floor, 0.5);
    near(envelopeMeasures(read(id).chain.footprint, read(id).envelope)!.volume, 30);
    assert.equal(remeshes.length, 1);
  });

  it('the mounted ceiling-shape control actually switches to a three-point pitched gesture', () => {
    const id = room(); start(id);
    const ui = render(<SpaceEnvelopeBar gesture={gesture()} ctx={context()} />);
    const pitched = [...ui.querySelectorAll('button')].find(b => b.textContent === 'Pitched');
    assert.ok(pitched); click(pitched);
    assert.equal(gesture().mode, 'pitched'); assert.equal(gesture().points.length, 3);
  });

  it('rejects an invalid ceiling before creating entities or undo records', () => {
    const id = room(); start(id);
    const view = s().mutationViews.get(MODEL_ID)!;
    const mutations = view.getMutations().slice(), entities = view.getNewEntities().slice();
    const g = { ...gesture(), floor: 5, changed: true };
    const outcome = runTransaction(useViewerStore, getModelingCommand(SPACE_ENVELOPE.id)!, g, context());
    assert.equal(outcome.ok, false);
    assert.deepEqual(view.getMutations(), mutations); assert.deepEqual(view.getNewEntities(), entities);
    assert.equal(remeshes.length, 0);
  });

  it('a millimetre model writes native lengths and cubic units, with the same physical volume', async t => {
    if (!envelopeWasm(t)) return;
    await seedModelingSession({ unit: 'millimetre', storeyOffset: [10, 20] });
    const id = room(); start(id); apply('pitched', 2, 2, 4, 0.5);
    const exported = await exportEnvelope(MODEL_ID), parsedId = exported.parsed.entities.getByType(IfcTypeEnum.IfcSpace)[0];
    const mesh = envelopeMesh(exported.text, parsedId);
    near(mesh.volume, 30); near(mesh.minZ, 0.5); near(mesh.maxZ, 4);
    const quantities = exported.view.getQuantitiesForEntity(parsedId).flatMap(q => q.quantities);
    near(quantities.find(q => q.name === 'Height')!.value, 3500);
    near(quantities.find(q => q.name === 'GrossVolume')!.value, 30e9);
  });

  it('concave footprints integrate both sides of a ridge without assuming a rectangle', () => {
    const envelope = sectionEnvelope({ direction: [1, 0], points: [[0, 2], [2, 4], [4, 2]], floor: 0 })!;
    // 4x3 minus upper-right 2x2; full volume 36 minus 2*integral_2^4(6-x) = 12.
    near(envelopeMeasures([[0, 0], [4, 0], [4, 1], [2, 1], [2, 3], [0, 3]], envelope)!.volume, 24);
  });
});

// The source model is a real Archicad export. This exercises an authored space
// attached to its spatial tree; unsupported original mesh spaces are also kept.
describe('space envelopes in an authoring-tool model (#6686)', () => {
  it('edits a created space in AC20-FZK-Haus without changing an original mesh space', async t => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { IfcParser } = await import('@ifc-lite/parser');
    const path = resolve(import.meta.dirname, '../../../../../../../tests/models/ara3d/AC20-FZK-Haus.ifc');
    if (!existsSync(path)) { t.skip('AC20 fixture absent: run pnpm fixtures ara3d/AC20-FZK-Haus.ifc'); return; }
    if (!envelopeWasm(t)) return;
    const bytes = readFileSync(path);
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
    const model = s().models.get(MODEL_ID)!;
    useViewerStore.setState({ models: new Map([[MODEL_ID, { ...model, ifcDataStore: store }]]), mutationViews: new Map(), storeEditors: new Map() });
    const storeyId = store.entities.getByType(IfcTypeEnum.IfcBuildingStorey)[0];
    const original = store.entities.getByType(IfcTypeEnum.IfcSpace)[0];
    const editor = modelEditTarget(s(), MODEL_ID)!;
    assert.equal(readSpaceEnvelope(editor, original), null, 'a faceted source is refused');
    const originalMesh = envelopeMesh(bytes.toString('utf8'), original);
    select(original); s().startCommand('space.envelope'); commitCommand();
    assert.equal(editor.view.getMutations().length, 0, 'unsupported source is refused before writing');
    s().endCommand('cancel');
    const originalName = store.entities.getName(original), originalGuid = store.entities.getGlobalId(original);
    const id = made(s().addSpace(MODEL_ID, storeyId, { Profile: 'polygon', OuterCurve: [[0, 0], [4, 0], [4, 3], [0, 3]], Height: 3, Position: [0, 0, 0], Name: 'AC20 envelope' }));
    start(id); apply('pitched', 2, 2, 5, 0.5);
    const { text, parsed } = await exportEnvelope(MODEL_ID);
    const parsedId = parsed.entities.getByType(IfcTypeEnum.IfcSpace).find(i => parsed.entities.getName(i) === 'AC20 envelope');
    assert.ok(parsedId);
    near(envelopeMesh(text, parsedId).volume, 36);
    const originalId = parsed.entities.getByType(IfcTypeEnum.IfcSpace).find(i => parsed.entities.getGlobalId(i) === originalGuid);
    assert.ok(originalId); assert.equal(parsed.entities.getName(originalId), originalName);
    const savedOriginalMesh = envelopeMesh(text, originalId);
    near(savedOriginalMesh.volume, originalMesh.volume);
    near(savedOriginalMesh.minZ, originalMesh.minZ); near(savedOriginalMesh.maxZ, originalMesh.maxZ);
    assert.equal(s().mutationViews.get(MODEL_ID)!.getPositionalMutationsForEntity(original), null);
  });
});
