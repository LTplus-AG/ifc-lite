/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useViewerStore } from '@/store';
import { B_OFFSET, SHARED, VIEWPOINT, W1, W2, cameraStub, sceneModels } from '@/test/scene-actions-fixture';
import { parseSceneActions } from './scene-actions';
import { applySceneActions } from './scene-apply';
import { restoreSceneApplication } from './scene-restore';
import { setActiveApplication, useSceneSession } from './scene-session';

const initial = useViewerStore.getState();
afterEach(() => { setActiveApplication(null); useViewerStore.setState(initial, true); });

const set = (actions: unknown[], title = 'Show failing') => parseSceneActions(JSON.stringify({ version: 1, kind: 'scene.actions', title, actions }));
const store = () => useViewerStore.getState();
const sorted = (ids: Iterable<number> | null | undefined) => ids ? [...ids].sort((a, b) => a - b) : null;
const restore = () => {
  const active = useSceneSession.getState().active;
  assert.ok(active, 'an application is active');
  return Object.fromEntries(restoreSceneApplication(active).channels.map(({ channel, outcome }) => [channel, outcome]));
};
const SECTION = { type: 'section', units: 'mm', plane: { origin: [1_005_000, 2_003_000, 1500], normal: [0, 0, 1] } };

/** A scene with a clash X-ray ghost, a user hide, a painted validation overlay and a selection — all before the assistant acts. */
function priorScene() {
  const camera = cameraStub();
  useViewerStore.setState({ ...sceneModels(), cameraCallbacks: camera.callbacks });
  store().setSelectedEntityIds([102]);
  store().addEntitiesToSelection([{ modelId: 'a', expressId: 102 }]);
  const ghost = new Set([102]);
  useViewerStore.setState({ ghostExceptEntities: ghost });
  useViewerStore.setState({ clashVisibilityOwned: { channel: 'ghost', ids: ghost } });
  store().hideEntities([B_OFFSET + 103]);
  store().setPendingColorUpdates(new Map([[102, [0, 0.8, 0, 1]]]));
  store().setIdsColorRevision(store().colorPresentationRevision);
  return camera;
}

// #6907: every channel round-trips through the real store, and restore hands each one back exactly.
test('apply then restore round-trips selection, isolation with its prior owner, hides, colours, section and camera', () => {
  const camera = priorScene();
  const before = store();
  const result = applySceneActions(set([
    { type: 'select', targets: [{ globalId: W1 }] },
    { type: 'isolate', targets: [{ globalId: W1 }, { globalId: W2 }] },
    { type: 'hide', targets: [{ globalId: W2 }, { globalId: SHARED, modelId: 'b' }] },
    { type: 'colour', groups: [{ label: 'Failing', colour: 'red', targets: [{ globalId: W1 }] }] },
    SECTION,
    { type: 'camera', units: 'm', eye: [1030, 2020, 15], target: [1005, 2003, 1] },
  ]), null);
  assert.ok(result);
  assert.deepEqual(result.applied.map(a => a.type), ['hide', 'isolate', 'colour', 'select', 'section', 'camera']);
  const applied = store();
  assert.deepEqual(sorted(applied.selectedEntityIds), [101]);
  assert.equal(applied.selectedEntity?.expressId, 101, 'Properties follows the selection too');
  assert.deepEqual(sorted(applied.isolatedEntities), [101, 102]);
  assert.equal(applied.ghostExceptEntities, null);
  assert.equal(applied.clashVisibilityOwned, null, 'the clash claim lapses while the assistant isolation is shown');
  assert.deepEqual(sorted(applied.hiddenEntities), [102, B_OFFSET + 103]);
  assert.deepEqual(applied.pendingColorUpdates?.get(101), [0.86, 0.15, 0.15, 1]);
  assert.deepEqual(applied.pendingColorUpdates?.get(102), [0, 0.8, 0, 1], 'colours layer onto what was painted');
  assert.ok(applied.sectionPlane.enabled && applied.sectionPlane.custom);
  assert.deepEqual(camera.current().position, { x: 30, y: 15, z: -20 });

  assert.deepEqual(restore(), { selection: 'restored', isolate: 'restored', hide: 'restored', colour: 'restored', section: 'restored', camera: 'restored' });
  const after = store();
  assert.deepEqual(sorted(after.selectedEntityIds), [102]);
  assert.equal(after.selectedEntity?.expressId, 102);
  assert.equal(after.isolatedEntities, null);
  assert.deepEqual(sorted(after.ghostExceptEntities), [102]);
  assert.deepEqual(after.clashVisibilityOwned && sorted(after.clashVisibilityOwned.ids), [102], 'clash owns its ghost again, so its own teardown still releases it');
  assert.deepEqual(sorted(after.hiddenEntities), [B_OFFSET + 103], 'the user-hidden slab stays hidden');
  assert.deepEqual([...(after.pendingColorUpdates ?? [])], [[102, [0, 0.8, 0, 1]]]);
  assert.equal(after.idsColorRevision, after.colorPresentationRevision, 'validation colours are claimed by IDS again');
  assert.equal(after.sectionPlane, before.sectionPlane);
  assert.deepEqual(camera.current(), VIEWPOINT);
  assert.equal(useSceneSession.getState().active, null);
});

test('restore never overwrites later user changes and says which channels it kept', () => {
  priorScene();
  applySceneActions(set([
    { type: 'select', targets: [{ globalId: W1 }] },
    { type: 'isolate', targets: [{ globalId: W1 }] },
    { type: 'colour', groups: [{ label: 'Failing', colour: 'red', targets: [{ globalId: W1 }] }] },
    SECTION,
  ]), null);
  // The user carries on: their own isolation, selection, colours and section.
  store().isolateEntities([102]);
  store().setSelectedEntityIds([102]);
  store().setPendingColorUpdates(new Map([[101, [1, 1, 0, 1]]]));
  store().setSectionPlanePosition(20);
  const user = store();
  assert.deepEqual(restore(), { selection: 'changed', isolate: 'changed', colour: 'changed', section: 'changed' });
  const after = store();
  assert.equal(after.isolatedEntities, user.isolatedEntities);
  assert.equal(after.selectedEntityIds, user.selectedEntityIds);
  assert.equal(after.colorPresentationRevision, user.colorPresentationRevision, 'no colour write');
  assert.equal(after.sectionPlane, user.sectionPlane);
});

test('a stale isolation claim is dropped, so an equal isolation installed later by someone else survives restore (#2654 class)', () => {
  useViewerStore.setState(sceneModels());
  applySceneActions(set([{ type: 'isolate', targets: [{ globalId: W1 }] }]), null);
  store().isolateEntities([102]); // user replaces the channel …
  assert.equal(useSceneSession.getState().active?.isolate?.claim, null, 'the claim lapses at the first replacing write');
  useViewerStore.setState({ isolatedEntities: new Set([101]) }); // … and another feature later installs equal content
  assert.equal(restore().isolate, 'changed');
  assert.deepEqual(sorted(store().isolatedEntities), [101]);
});

test('hiding only records ids the user had not hidden, and restore reveals only those', () => {
  useViewerStore.setState(sceneModels());
  store().hideEntities([101]);
  applySceneActions(set([{ type: 'hide', targets: [{ globalId: W1 }, { globalId: W2 }] }]), null);
  assert.deepEqual(sorted(store().hiddenEntities), [101, 102]);
  assert.equal(restore().hide, 'restored');
  assert.deepEqual(sorted(store().hiddenEntities), [101]);
});

test('frame uses the native framing callback; camera actions without a renderer are reported, not faked', () => {
  const camera = cameraStub();
  useViewerStore.setState({ ...sceneModels(), cameraCallbacks: camera.callbacks });
  const framed = applySceneActions(set([{ type: 'frame', targets: [{ globalId: W1 }, { globalId: SHARED, modelId: 'b' }] }]), null);
  assert.deepEqual(framed?.applied, [{ type: 'frame', count: 2 }]);
  assert.deepEqual(camera.framed, [[101, B_OFFSET + 103]]);
  assert.equal(restore().camera, 'restored');
  assert.deepEqual(camera.current(), VIEWPOINT);

  useViewerStore.setState({ cameraCallbacks: {} });
  const none = applySceneActions(set([{ type: 'frame', targets: [{ globalId: W1 }] }]), null);
  assert.deepEqual(none?.unavailable, ['frame']);
  assert.equal(useSceneSession.getState().active, null, 'nothing changed, so there is nothing to restore');
  assert.equal(applySceneActions(set([{ type: 'select', targets: [{ globalId: '0Missing00000000000000' }] }]), null), null,
    'a set with nothing ready changes nothing');
});

test('a second apply restores the first before capturing, and a changed federation blocks restore', () => {
  useViewerStore.setState(sceneModels());
  applySceneActions(set([{ type: 'isolate', targets: [{ globalId: W1 }] }], 'First'), null);
  const second = applySceneActions(set([{ type: 'hide', targets: [{ globalId: W2 }] }], 'Second'), null);
  assert.deepEqual(second?.replaced?.channels, [{ channel: 'isolate', outcome: 'restored' }]);
  assert.equal(store().isolatedEntities, null);
  assert.equal(useSceneSession.getState().active?.title, 'Second');

  const { models } = sceneModels();
  models.delete('b');
  useViewerStore.setState({ models });
  assert.deepEqual(restore(), { hide: 'models-changed' });
  assert.ok(store().hiddenEntities.has(102), 'ids of a different federation are not written back');
});

// #6907: a section box rides the same sectionPlane object as a plane, so restore removes the assistant's box too.
test('a section box applies through setSectionBox and restore puts back the prior section, box removed', () => {
  useViewerStore.setState({ ...sceneModels(), cameraCallbacks: cameraStub().callbacks });
  const before = store().sectionPlane;
  assert.equal(before.box, undefined);
  const result = applySceneActions(set([{ type: 'section', units: 'm', box: { min: [1002, 2002, 0.5], max: [1010, 2008, 3] } }]), null);
  assert.deepEqual(result?.applied.map(a => a.type), ['section']);
  assert.ok(store().sectionPlane.box && store().sectionPlane.enabled, 'the box is installed');
  assert.deepEqual(restore(), { section: 'restored' });
  assert.equal(store().sectionPlane, before, 'the prior section object is back, without the box');
});
