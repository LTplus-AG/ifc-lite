/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { resolvePresentationLayers } from './presentation-layers.js';
import { generatedLayerModel } from '../test/fixtures/presentation-layer-model.js';

// #9906: opening the layer tree on a 326 MB BREP export decoded every face,
// bound and loop of the model (795,329 records) once per tree build, and one
// click builds the tree several times. These pin what the index may read.

const WALLS = 400;
const RECORDS_PER_WALL = 31;
const wallId = (wall: number) => wall * RECORDS_PER_WALL + 1;
const shapeId = (wall: number) => wall * RECORDS_PER_WALL + 3;
const wallIds = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => wallId(from + index));

/** Layers assigned the way the reported export assigns them: to shape representations. */
function representationLayerModel(deepLayer = false): string {
  const shapes = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => `#${shapeId(from + index)}`).join(',');
  return generatedLayerModel(WALLS, deepLayer).replace('ENDSEC;\nEND-ISO-10303-21;', [
    `#900001=IFCPRESENTATIONLAYERASSIGNMENT('Front',$,(${shapes(0, WALLS / 2)}),$);`,
    `#900002=IFCPRESENTATIONLAYERASSIGNMENT('Back',$,(${shapes(WALLS / 2, WALLS)}),$);`,
    'ENDSEC;\nEND-ISO-10303-21;',
  ].join('\n'));
}

async function parse(text: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer, { disableWorkerScan: true });
}

/** Every record the resolver decodes from the source, by STEP class. */
function recordDecodes(store: IfcDataStore): string[] {
  const decoded: string[] = [];
  const getEntity = store.getEntity.bind(store);
  store.getEntity = (expressId: number) => {
    const entity = getEntity(expressId);
    decoded.push(entity?.type.toUpperCase() ?? 'MISSING');
    return entity;
  };
  return decoded;
}

const members = (layers: ReturnType<typeof resolvePresentationLayers>, name: string) =>
  layers.find(layer => layer.Name === name)?.productIds;

test('#9906 layers assigned to shape representations resolve without decoding the geometry below them', async () => {
  const store = await parse(representationLayerModel());
  const decoded = recordDecodes(store);
  const layers = resolvePresentationLayers(store);
  assert.deepEqual(members(layers, 'Front'), wallIds(0, WALLS / 2));
  assert.deepEqual(members(layers, 'Back'), wallIds(WALLS / 2, WALLS));
  const classes = new Map<string, number>();
  for (const type of decoded) classes.set(type, (classes.get(type) ?? 0) + 1);
  // One read of each wall, product shape and shape representation, and of the
  // two assignments. None of the 28 BREP records under each wall.
  assert.deepEqual(Object.fromEntries([...classes].sort()), {
    IFCPRESENTATIONLAYERASSIGNMENT: 2,
    IFCPRODUCTDEFINITIONSHAPE: WALLS,
    IFCSHAPEREPRESENTATION: WALLS,
    IFCWALL: WALLS,
  });
});

test('#9906 one index answers every later request for the same model without reading it again', async () => {
  const store = await parse(representationLayerModel());
  const decoded = recordDecodes(store);
  const first = resolvePresentationLayers(store);
  const built = decoded.length;
  assert.ok(built > 0, 'the first request reads the model');
  const second = resolvePresentationLayers(store);
  const third = resolvePresentationLayers(store, null);
  assert.equal(decoded.length, built, 'later requests decode nothing');
  assert.equal(second, first, 'the same index is returned');
  assert.equal(third, first, 'no overlay is one state, however it is spelled');
  // Shared between every tree build: a caller cannot reorder or edit it for the others.
  assert.throws(() => (first as unknown[]).reverse(), TypeError);
  assert.throws(() => (first[0].productIds as number[]).push(1), TypeError);
});

test('#9906 an edit rebuilds the index and leaves the earlier answer as it was', async () => {
  const store = await parse(representationLayerModel());
  const view = new MutablePropertyView(null, 'legacy');
  const before = resolvePresentationLayers(store, view);
  assert.equal(resolvePresentationLayers(store, view), before);
  // The first wall now takes the product shape of a wall on the other layer.
  view.setAttribute(wallId(0), 'Representation', `#${wallId(WALLS / 2) + 1}`);
  const after = resolvePresentationLayers(store, view);
  assert.deepEqual(members(after, 'Front'), wallIds(1, WALLS / 2));
  assert.deepEqual(members(after, 'Back'), [wallId(0), ...wallIds(WALLS / 2, WALLS)]);
  assert.deepEqual(members(before, 'Front'), wallIds(0, WALLS / 2));
  assert.equal(resolvePresentationLayers(store, view), after);
  // The unedited model is a different state of the same store, not a stale hit.
  assert.deepEqual(members(resolvePresentationLayers(store), 'Front'), wallIds(0, WALLS / 2));
});

test('#9906 a layer assigned below a shape model still resolves through the geometry', async () => {
  // `generatedLayerModel` assigns its own layer to a corner point of the first
  // wall: four ownership levels below that wall's shape representation.
  const store = await parse(representationLayerModel(true));
  const decoded = recordDecodes(store);
  const layers = resolvePresentationLayers(store);
  assert.deepEqual(members(layers, 'BREP layer'), [wallId(0)]);
  assert.deepEqual(members(layers, 'Front'), wallIds(0, WALLS / 2));
  assert.deepEqual(members(layers, 'Back'), wallIds(WALLS / 2, WALLS));
  assert.ok(decoded.includes('IFCPOLYLOOP'), 'the constituents are walked when an assignment needs them');
});

test('#9906 two overlays of one shared store each keep their own index', async () => {
  // Federated models may share a store under distinct ID spaces and overlays;
  // the tree asks for both on every build.
  const store = await parse(representationLayerModel());
  const first = new MutablePropertyView(null, 'first');
  const second = new MutablePropertyView(null, 'second');
  second.deleteEntity(wallId(0));
  const forFirst = resolvePresentationLayers(store, first);
  const forSecond = resolvePresentationLayers(store, second);
  assert.deepEqual(members(forFirst, 'Front'), wallIds(0, WALLS / 2));
  assert.deepEqual(members(forSecond, 'Front'), wallIds(1, WALLS / 2));
  assert.equal(resolvePresentationLayers(store, first), forFirst, 'the second overlay did not evict the first');
  assert.equal(resolvePresentationLayers(store, second), forSecond);
});
