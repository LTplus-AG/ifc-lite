/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getAttributeNames } from '@ifc-lite/parser';
import type { IfcAttributeValue } from '@ifc-lite/data';
import { extractStructuralOnDemand } from '../../../../../../packages/parser/src/structural-extractor.js';
import { structuralEvidenceFixture } from '@/test/structural-evidence-fixture';
import { exportAndReparse } from '@/test/properties-panel-harness';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { useViewerStore } from '@/store';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));

test('#7195 a native source action retargeted to a real IfcSpace does not invent structural load components', async () => {
  const { file, actionId } = await structuralEvidenceFixture();
  const before = extractStructuralOnDemand(file);
  assert.equal(before.activities[0].appliedLoad?.components.ForceX, 1234);
  assert.equal(file.entities.getTypeName(89), 'IfcSpace');
  const view = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(view);
  view.setAttribute(actionId, 'AppliedLoad', '#89');
  const saved = await exportAndReparse('native', file);
  assert.equal(saved.getEntity(actionId)?.attributes[getAttributeNames('IfcStructuralSurfaceAction').indexOf('AppliedLoad')], 89);
  assert.equal(extractStructuralOnDemand(saved).activities[0].appliedLoad, undefined);
});

test('#7195 native configuration keeps wrong-target slots without reporting an IfcSpace as a load', async () => {
  const { file, actionId, loadId } = await structuralEvidenceFixture();
  const view = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(view);
  view.setExpressIdWatermark(200_000);
  const configuration = view.createEntity('IfcStructuralLoadConfiguration', ['Native paired stations', [`#${loadId}`, '#89', `#${loadId}`], [[0], [1], [2]]]);
  view.setAttribute(actionId, 'AppliedLoad', `#${configuration.expressId}`);
  const saved = await exportAndReparse('native', file);
  assert.deepEqual(saved.getEntity(configuration.expressId)?.attributes[1], [loadId, 89, loadId]);
  const entries = extractStructuralOnDemand(saved).activities[0].appliedLoad?.configuration?.entries;
  assert.ok(entries); assert.equal(entries.length, 3);
  assert.equal(entries[0].value?.components.ForceX, 1234);
  assert.equal(entries[2].value?.components.ForceX, 1234);
  assert.equal(entries[1].value, undefined);
  assert.equal(entries[1].dropped, 'invalid-reference');
  assert.deepEqual(entries[1].location, [1]);
});

test('#7195 native support references cannot reinterpret a real IfcSpace as boundary stiffness', async () => {
  const { file } = await structuralEvidenceFixture();
  const view = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(view);
  view.setExpressIdWatermark(200_000);
  const author = (type: string, fields: Record<string, IfcAttributeValue>) => view.createEntity(type,
    getAttributeNames(type).map(name => fields[name] ?? null));
  const condition = author('IfcBoundaryNodeCondition', { Name: 'Native rigid support', TranslationalStiffnessX: true });
  const connection = author('IfcStructuralPointConnection', { GlobalId: '0000000000000000000009', Name: 'Native point connection', AppliedCondition: `#${condition.expressId}` });
  const good = await exportAndReparse('native', file);
  assert.equal(extractStructuralOnDemand(good).connections.find(row => row.expressId === connection.expressId)?.appliedCondition?.components.TranslationalStiffnessX, true);
  view.setAttribute(connection.expressId, 'AppliedCondition', '#89');
  const saved = await exportAndReparse('native', file);
  assert.equal(saved.getEntity(connection.expressId)?.attributes[getAttributeNames('IfcStructuralPointConnection').indexOf('AppliedCondition')], 89);
  assert.equal(extractStructuralOnDemand(saved).connections.find(row => row.expressId === connection.expressId)?.appliedCondition, undefined);
});
