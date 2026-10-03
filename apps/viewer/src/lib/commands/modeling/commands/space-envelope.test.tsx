/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcTypeEnum, QuantityType } from '@ifc-lite/data';
import { applyStylesInStore } from '@ifc-lite/create';
import { getMaxExpressId } from '@/hooks/ingest/viewerModelIngest';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { cleanup, click, render } from '@/test/render';
import { envelopeWasm, envelopeMesh, exportEnvelope } from '@/test/space-envelope-oracle';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { setRequestRemesh, runTransaction, type RemeshRequest } from '../transaction';
import { getModelingCommand } from '../registry';
import { getCommandRuntime, updateCommandGesture, commitCommand, commandPointerDown, commandPointerMove } from '../runtime';
import type { SpaceEnvelopeGesture } from './space-envelope';
import '../builtin';

let readSpaceEnvelope: typeof import('@/lib/rooms/space-envelope-read')['readSpaceEnvelope'];

let envelopeMeasures: typeof import('@/lib/rooms/space-envelope')['envelopeMeasures'];
let sectionEnvelope: typeof import('@/lib/rooms/space-envelope')['sectionEnvelope'];

let SpaceEnvelopeBar: typeof import('@/components/viewer/tools/command/SpaceEnvelopeHud')['SpaceEnvelopeBar'];

let SPACE_ENVELOPE: typeof import('./space-envelope')['SPACE_ENVELOPE'];
let setEnvelopeMode: typeof import('./space-envelope')['setEnvelopeMode'];

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
let restore: () => void = () => {};
let remeshes: RemeshRequest[];
beforeEach(async () => {
  await seedModelingSession();
  // Exercise registration even when a production revert removes the new modules.
  assert.ok(getModelingCommand('space.envelope'), '#6686 requires the envelope command to be registered');
  ({ SPACE_ENVELOPE, setEnvelopeMode } = await import('./space-envelope'));
  ({ SpaceEnvelopeBar } = await import('@/components/viewer/tools/command/SpaceEnvelopeHud'));
  ({ envelopeMeasures, sectionEnvelope } = await import('@/lib/rooms/space-envelope'));
  ({ readSpaceEnvelope } = await import('@/lib/rooms/space-envelope-read'));
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
      start(id); apply(mode, 2, mode === 'slope' ? 5 : 2, 5);
      const edited = read(id), expectedVolume = 42;
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
      near(mesh.volume, expectedVolume); near(mesh.minZ, 0); near(mesh.maxZ, 5);
      assert.ok(mesh.points.some(p => Math.abs(p[2] - 2) < 1e-4));
      near(exported.view.getQuantitiesForEntity(parsedId).flatMap(q => q.quantities).find(q => q.name === 'GrossVolume')!.value, expectedVolume);
      assert.equal(exported.view.getQuantitiesForEntity(parsedId).flatMap(q => q.quantities).find(q => q.name === 'Height'), undefined,
        'IFC Height is provided only for constant-height spaces');
      s().undo(MODEL_ID);
      near(envelopeMeasures(read(id).chain.footprint, read(id).envelope)!.volume, 36);
      assert.equal(read(id).envelope.ceiling.length, 1);
      assert.equal(read(id).envelope.ceiling[0].a, 0);
      near(s().mutationViews.get(MODEL_ID)!.getQuantitiesForEntity(id).flatMap(q => q.quantities).find(q => q.name === 'Height')!.value, 3);
      near(s().mutationViews.get(MODEL_ID)!.getQuantitiesForEntity(id).flatMap(q => q.quantities).find(q => q.name === 'GrossVolume')!.value, 36);
      s().redo(MODEL_ID);
      near(envelopeMeasures(read(id).chain.footprint, read(id).envelope)!.volume, expectedVolume);
      assert.equal(read(id).envelope.ceiling.length, mode === 'slope' ? 1 : 2);
      const redone = await exportEnvelope(MODEL_ID), redoneId = redone.parsed.entities.getByType(IfcTypeEnum.IfcSpace)[0];
      const redoneMesh = envelopeMesh(redone.text, redoneId);
      near(redoneMesh.volume, expectedVolume); near(redoneMesh.maxZ, 5);
      near(redone.view.getQuantitiesForEntity(redoneId).flatMap(q => q.quantities).find(q => q.name === 'GrossVolume')!.value, expectedVolume);
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
    near(s().mutationViews.get(MODEL_ID)!.getQuantitiesForEntity(id).flatMap(q => q.quantities).find(q => q.name === 'Height')!.value, 2.5);
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
    const id = room();
    // This fixture declares only millimetre lengths, so derived area units are
    // mm² as well. Supply quantities in their declared units before editing.
    const view = s().mutationViews.get(MODEL_ID)!;
    for (const name of ['GrossFloorArea', 'NetFloorArea']) view.setQuantity(id, 'Qto_SpaceBaseQuantities', name, 12e6, QuantityType.Area);
    view.setQuantity(id, 'Qto_SpaceBaseQuantities', 'GrossVolume', 36e9, QuantityType.Volume);
    start(id); apply('pitched', 2, 2, 4, 0.5);
    const exported = await exportEnvelope(MODEL_ID), parsedId = exported.parsed.entities.getByType(IfcTypeEnum.IfcSpace)[0];
    const mesh = envelopeMesh(exported.text, parsedId);
    near(mesh.volume, 30); near(mesh.minZ, 0.5); near(mesh.maxZ, 4);
    const quantities = exported.view.getQuantitiesForEntity(parsedId).flatMap(q => q.quantities);
    assert.equal(quantities.find(q => q.name === 'Height'), undefined);
    near(quantities.find(q => q.name === 'GrossVolume')!.value, 30e9);
  });

  it('invalidates unavailable gross-envelope and finish measures while retaining the verified net volume', async t => {
    if (!envelopeWasm(t)) return;
    const id = made(s().addSpace(MODEL_ID, STOREY, { Profile: 'polygon', OuterCurve: [[0, 0], [4, 0], [4, 3], [0, 3]],
      Position: [0, 0, 0], Height: 3, grossFloorArea: 15, netFloorArea: 12 }));
    const view = s().mutationViews.get(MODEL_ID)!;
    view.setQuantity(id, 'Qto_SpaceBaseQuantities', 'NetVolume', 36, QuantityType.Volume);
    // These valid source quantities become unverifiable after roof/floor edits.
    for (const name of ['GrossWallArea', 'NetWallArea', 'GrossCeilingArea', 'NetCeilingArea']) {
      view.setQuantity(id, 'Qto_SpaceBaseQuantities', name, 12, QuantityType.Area);
    }
    for (const name of ['FinishCeilingHeight', 'FinishFloorHeight']) {
      view.setQuantity(id, 'Qto_SpaceBaseQuantities', name, 0.2, QuantityType.Length);
    }
    start(id); apply('pitched', 2, 2, 4, 0.5);
    const exported = await exportEnvelope(MODEL_ID), parsedId = exported.parsed.entities.getByType(IfcTypeEnum.IfcSpace)[0];
    near(envelopeMesh(exported.text, parsedId).volume, 30);
    const quantities = exported.view.getQuantitiesForEntity(parsedId).flatMap(q => q.quantities);
    near(quantities.find(q => q.name === 'NetVolume')!.value, 30);
    near(quantities.find(q => q.name === 'GrossFloorArea')!.value, 15);
    near(quantities.find(q => q.name === 'NetFloorArea')!.value, 12);
    for (const name of ['Height', 'GrossVolume', 'GrossWallArea', 'NetWallArea', 'GrossCeilingArea', 'NetCeilingArea', 'FinishCeilingHeight', 'FinishFloorHeight']) {
      assert.equal(quantities.find(q => q.name === name), undefined, `${name} cannot be verified from this net outline`);
    }
    s().undo(MODEL_ID);
    near(view.getQuantitiesForEntity(id).flatMap(q => q.quantities).find(q => q.name === 'GrossVolume')!.value, 45);
    near(view.getQuantitiesForEntity(id).flatMap(q => q.quantities).find(q => q.name === 'GrossCeilingArea')!.value, 12);
  });

  it('does not overwrite a source net volume that excludes unavailable construction geometry', () => {
    const id = room(), view = s().mutationViews.get(MODEL_ID)!;
    view.setQuantity(id, 'Qto_SpaceBaseQuantities', 'NetVolume', 34, QuantityType.Volume);
    start(id); apply('slope', 2, 4, 4, 0.5);
    const quantities = view.getQuantitiesForEntity(id).flatMap(q => q.quantities);
    near(quantities.find(q => q.name === 'GrossVolume')!.value, 30);
    assert.equal(quantities.find(q => q.name === 'NetVolume'), undefined,
      'the envelope cannot recompute a volume excluding construction inside the space');
  });

  it('does not invent gross-volume provenance when the source has no gross floor measure', () => {
    const id = room(), view = s().mutationViews.get(MODEL_ID)!;
    view.deleteQuantity(id, 'Qto_SpaceBaseQuantities', 'GrossFloorArea');
    view.setQuantity(id, 'Qto_SpaceBaseQuantities', 'NetVolume', 36, QuantityType.Volume);
    start(id); apply('slope', 2, 4, 4, 0.5);
    const quantities = view.getQuantitiesForEntity(id).flatMap(q => q.quantities);
    assert.equal(quantities.find(q => q.name === 'GrossVolume'), undefined);
    near(quantities.find(q => q.name === 'NetVolume')!.value, 30);
  });

  it('does not invent gross or net volumes when the source lacks their provenance (#6739)', () => {
    const id = room(), view = s().mutationViews.get(MODEL_ID)!;
    view.deleteQuantity(id, 'Qto_SpaceBaseQuantities', 'GrossVolume');
    start(id); apply('slope', 2, 5);
    near(envelopeMeasures(read(id).chain.footprint, read(id).envelope)!.volume, 42);
    const quantities = view.getQuantitiesForEntity(id).flatMap(q => q.quantities);
    for (const name of ['GrossVolume', 'NetVolume']) assert.equal(quantities.find(q => q.name === name), undefined);
  });

  it('refuses an unreadable source style attachment before creating body entities (#6739)', () => {
    const id = room(), target = modelEditTarget(s(), MODEL_ID)!;
    target.editor.addEntity('IfcStyledItem', [`#${read(id).chain.extrudedSolidId}`, ['#999999999'], null]);
    start(id);
    const mutations = target.view.getMutations().slice(), entities = target.view.getNewEntities().slice();
    const outcome = runTransaction(useViewerStore, getModelingCommand(SPACE_ENVELOPE.id)!, { ...gesture(), floor: 0.5 }, context());
    assert.equal(outcome.ok, false);
    assert.deepEqual(target.view.getMutations(), mutations); assert.deepEqual(target.view.getNewEntities(), entities);
    assert.equal(remeshes.length, 0);
  });

  it('preserves actual wasm style colour on a replaced body and after reload/re-edit', async t => {
    if (!envelopeWasm(t)) return;
    const id = room(), target = modelEditTarget(s(), MODEL_ID)!;
    applyStylesInStore(target.editor, target.dataStore, [{ products: [id], color: { red: 0.8, green: 0.2, blue: 0.1, alpha: 0.75 } }]);
    const before = await exportEnvelope(MODEL_ID), beforeId = before.parsed.entities.getByType(IfcTypeEnum.IfcSpace)[0];
    const colors = envelopeMesh(before.text, beforeId).colors;
    // The WASM prepass colour wire is RGBA8. Compare actual mesh output across
    // edits below, and verify this source's known quantized RGBA independently.
    assert.ok(colors.length > 0);
    colors.forEach(c => [204, 51, 26, 191].forEach((byte, i) => near(c[i], byte / 255)));
    start(id); apply('pitched', 2, 2, 4, 0.5);
    const exported = await exportEnvelope(MODEL_ID), parsedId = exported.parsed.entities.getByType(IfcTypeEnum.IfcSpace)[0];
    assert.deepEqual(envelopeMesh(exported.text, parsedId).colors, colors);
    const model = s().models.get(MODEL_ID)!;
    useViewerStore.setState({ models: new Map([[MODEL_ID, { ...model, ifcDataStore: exported.parsed,
      maxExpressId: getMaxExpressId(exported.parsed, []) }]]), mutationViews: new Map(), storeEditors: new Map() });
    start(parsedId); apply('slope', 2, 4, 4, 0.5);
    const again = await exportEnvelope(MODEL_ID), againId = again.parsed.entities.getByType(IfcTypeEnum.IfcSpace)[0];
    assert.deepEqual(envelopeMesh(again.text, againId).colors, colors);
    s().undo(MODEL_ID);
    const undone = await exportEnvelope(MODEL_ID);
    assert.deepEqual(envelopeMesh(undone.text, againId).colors, colors);
  });

  it('refuses a floor change with ElevationWithFlooring before writes but allows a ceiling change', () => {
    const id = room(), target = modelEditTarget(s(), MODEL_ID)!;
    target.editor.setPositionalAttribute(id, 10, 0);
    start(id);
    const mutations = target.view.getMutations().slice(), entities = target.view.getNewEntities().slice();
    const outcome = runTransaction(useViewerStore, getModelingCommand(SPACE_ENVELOPE.id)!, { ...gesture(), floor: 0.5 }, context());
    assert.equal(outcome.ok, false);
    assert.deepEqual(target.view.getMutations(), mutations); assert.deepEqual(target.view.getNewEntities(), entities);
    assert.equal(remeshes.length, 0);
    apply('slope', 2, 4);
    assert.equal(read(id).envelope.floor, 0);
    assert.equal(target.view.getPositionalMutationsForEntity(id)!.get(10), 0);
    assert.equal(remeshes.length, 1);
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
