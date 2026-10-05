/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { summarizeClashes, type Clash } from '@ifc-lite/clash';
import { useViewerStore } from '@/store';
import { captureEvidence } from '@/lib/assistant/evidence';
import { B_OFFSET, SHARED, W1, W2, sceneModels } from '@/test/scene-actions-fixture';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { parseSceneActions } from './scene-actions';
import { previewSceneActions } from './scene-preview';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));

const set = (actions: unknown[]) => parseSceneActions(JSON.stringify({ version: 1, kind: 'scene.actions', title: 'T', actions }));
const preview = (actions: unknown[], evidence: ReturnType<typeof captureEvidence> | null = null) =>
  previewSceneActions(useViewerStore.getState(), set(actions), evidence);

function validationReport() {
  return {
    source: { kind: 'ids', document: { info: { title: 't' }, specifications: [] } },
    modelInfo: [{ modelId: 'a', schema: 'IFC4' }],
    timestamp: new Date(0),
    summary: { totalSpecifications: 1, totalEntitiesChecked: 4, totalEntitiesPassed: 0, totalEntitiesFailed: 4, overallPassRate: 0 },
    specificationResults: [{
      specification: { id: 's1', name: 'Walls have FireRating', applicability: [], requirements: [] },
      status: 'fail', applicableCount: 4, passedCount: 0, failedCount: 4, passRate: 0,
      entityResults: [
        { expressId: 101, modelId: 'a', entityType: 'IfcWall', globalId: W1, passed: false, requirementResults: [] },
        { expressId: 102, modelId: 'a', entityType: 'IfcWall', passed: false, requirementResults: [] },
        { expressId: 0, modelId: '', entityType: 'IfcSlab', globalId: SHARED, passed: false, requirementResults: [] },
        { expressId: 999, modelId: 'a', entityType: 'IfcWall', passed: false, requirementResults: [] },
      ],
    }],
  } as unknown as NonNullable<ReturnType<typeof useViewerStore.getState>['idsValidationReport']>;
}

// #6907: targets resolve per model; nothing is guessed or widened.
test('GlobalId targets resolve per model and count missing and ambiguous ones', () => {
  useViewerStore.setState(sceneModels());
  const result = preview([
    { type: 'isolate', targets: [{ globalId: W1 }, { globalId: SHARED }, { globalId: '0Missing00000000000000' }, { globalId: SHARED, modelId: 'b' }] },
    { type: 'select', targets: [{ globalId: '0Missing00000000000000' }] },
  ]);
  const [isolate, select] = result.actions;
  assert.equal(isolate.status, 'ready');
  assert.deepEqual(isolate.ids, [101, B_OFFSET + 103], 'a model-scoped GlobalId resolves into that model\'s renderer range');
  assert.equal(isolate.counts.resolved, 2);
  assert.equal(isolate.counts.ambiguous, 1, 'a GlobalId present in two models without modelId is ambiguous, not both');
  assert.equal(isolate.counts.missing, 1);
  assert.equal(select.status, 'refused');
  assert.equal(select.reason, 'no-targets');
  assert.deepEqual([result.ready, result.refused], [1, 1]);
});

test('citations resolve live rows by shape and refuse once the evidence is stale', () => {
  useViewerStore.setState({ ...sceneModels(), idsValidationReport: validationReport() });
  const evidence = captureEvidence('validation');
  const actions = [{ type: 'hide', targets: ['E1', 'E2', 'E3', 'E4', 'E5', 'E99'].map(citation => ({ citation })) }];
  const [hide] = preview(actions, evidence).actions;
  assert.deepEqual(hide.ids, [101, 102], 'globalId rows and modelId+expressId rows both resolve');
  assert.deepEqual(hide.counts, { resolved: 2, missing: 1, ambiguous: 1, 'stale-citation': 0, 'unknown-citation': 1, 'no-identity': 1 });
  assert.equal(preview(actions, null).actions[0].counts['stale-citation'], 6, 'no evidence: citations cannot resolve');
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  const stale = preview(actions, evidence).actions[0];
  assert.equal(stale.status, 'refused');
  assert.equal(stale.counts['stale-citation'], 6, 'an edit since capture stops every citation from driving the scene');
  assert.equal(preview([{ type: 'hide', targets: [{ globalId: W2 }] }], evidence).actions[0].status, 'ready', 'GlobalIds do not depend on evidence');
});

test('clash citations resolve both elements of the live clash only', () => {
  const clash: Clash = { id: 'c1', rule: 'coordination', status: 'hard', severity: 'major', distance: -0.02, distanceKind: 'estimate',
    a: { model: 'a', key: 'wall', ref: 101, tag: 'IfcWall' }, b: { model: 'b', key: 'slab', ref: B_OFFSET + 103, tag: 'IfcSlab' },
    point: [0, 0, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] } };
  const result = { clashes: [clash], summary: summarizeClashes([clash]), rulesRun: [], settings: { tolerance: 0.002, excludeVoidsAndHosts: true } };
  useViewerStore.setState({ ...sceneModels(), clashResult: result, clashRawResult: result });
  const evidence = captureEvidence('clash');
  const [colour] = preview([{ type: 'colour', groups: [{ label: 'Hard', colour: 'red', targets: [{ citation: 'E1' }] },
    { label: 'Again', colour: 'blue', targets: [{ citation: 'E1' }] }, { label: 'Third', colour: 'green', targets: [{ citation: 'E1' }] }] }], evidence).actions;
  assert.deepEqual(colour.groups?.map(group => group.ids), [[101, B_OFFSET + 103], [], []], 'an element named twice keeps its first colour');
  assert.equal(colour.overlapping, 2, 'two distinct elements overlap, however many later groups name them');
});

test('coordinates convert from IFC world in stated units through the RTC frame, and implausible ones are refused', () => {
  useViewerStore.setState(sceneModels());
  const result = preview([
    // 1005 m east, 2003 m north, 1.5 m up — inside the building after the 1000/2000 m RTC offset.
    { type: 'section', units: 'mm', plane: { origin: [1_005_000, 2_003_000, 1500], normal: [0, 0, 2] } },
    { type: 'camera', units: 'm', eye: [1030, 2020, 15], target: [1005, 2003, 1] },
  ]);
  const [section, camera] = result.actions;
  assert.equal(section.status, 'ready');
  assert.deepEqual(section.plane, { point: { x: 5, y: 1.5, z: -3 }, normal: { x: 0, y: 1, z: 0 } }, 'Z-up IFC becomes Y-up render frame; north is −z');
  assert.equal(camera.status, 'ready');
  assert.deepEqual(camera.camera?.target, { x: 5, y: 1, z: -3 });

  const outside = preview([
    { type: 'section', units: 'm', plane: { origin: [5, 3, 1.5], normal: [0, 0, 1] } },
    { type: 'camera', units: 'm', eye: [1e6, 2003, 1], target: [1005, 2003, 1] },
  ]).actions;
  assert.deepEqual(outside.map(a => [a.status, a.reason]), [['refused', 'outside-bounds'], ['refused', 'outside-bounds']],
    'local coordinates that ignore the georeferenced frame land kilometres away and are refused');

  const [box] = preview([{ type: 'section', units: 'm', box: { min: [1001, 2001, 0], max: [1004, 2004, 3] } }]).actions;
  assert.deepEqual(box.box, { min: { x: 1, y: 0, z: -4 }, max: { x: 4, y: 3, z: -1 } }, 'box corners re-sort after the axis swap');
  const [farBox] = preview([{ type: 'section', units: 'm', box: { min: [0, 0, 0], max: [1, 1, 1] } }]).actions;
  assert.equal(farBox.reason, 'outside-bounds');

  useViewerStore.setState(fixtureModels(fixtureModel('m')));
  assert.equal(preview([{ type: 'section', units: 'm', plane: { origin: [0, 0, 0], normal: [0, 0, 1] } }]).actions[0].reason, 'no-bounds',
    'without geometry bounds coordinates cannot be checked, so they are refused');
});
