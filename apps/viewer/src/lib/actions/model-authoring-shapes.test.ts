/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useViewerStore } from '@/store';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { GROUND_STOREY, SAMPLE_MODEL, danglingReferences, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { parseModelAuthoringBatch } from './model-authoring';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
const proposal = (ifcClass: string, params: unknown) => JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native shape', units: 'm', frame: 'storey-local',
  operations: [{ op: 'element.create', ref: 'shape', ifcClass, storey: { globalId: GROUND_STOREY }, name: 'Native shape', params }] });

// #7215: both controls use public native builders on actual SketchUp IFC, then
// independent STEP export/reparse before checking reviewed contract support.
test('#7215 reviewed polygon slab accepts the existing native exported footprint', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const state = useViewerStore.getState();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY)!;
  const OuterCurve: Array<[number, number]> = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];
  state.addSlab(SAMPLE_MODEL, storey, { Profile: 'polygon', OuterCurve, Thickness: .2, Name: 'Native polygon control' });
  const bytes = editedModelBytes(dataStore, view);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)), []);
  const reparsed = await parseIfc(bytes);
  assert.ok([...reparsed.entityIndex.byId.values()].some((row) => row.type === 'IFCARBITRARYCLOSEDPROFILEDEF'), 'native exported polygon profile survives actual reparse');
  assert.doesNotThrow(() => parseModelAuthoringBatch(proposal('IfcSlab', { Profile: 'polygon', OuterCurve, thickness: .2 })), 'review must accept the already supported native footprint');
});

test('#7215 reviewed profiled beam accepts the existing native exported hollow section', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const state = useViewerStore.getState();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY)!;
  const Profile = { Type: 'CircleHollow' as const, Radius: .2, WallThickness: .02 };
  state.addBeam(SAMPLE_MODEL, storey, { Start: [0, 0, 3], End: [4, 0, 3], Profile, Name: 'Native pipe control' });
  const bytes = editedModelBytes(dataStore, view);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)), []);
  const reparsed = await parseIfc(bytes);
  assert.ok([...reparsed.entityIndex.byId.values()].some((row) => row.type === 'IFCCIRCLEHOLLOWPROFILEDEF'), 'native exported hollow section survives actual reparse');
  assert.doesNotThrow(() => parseModelAuthoringBatch(proposal('IfcBeam', { start: [0, 0, 3], end: [4, 0, 3], Profile })), 'review must accept the already supported native hollow section');
});
