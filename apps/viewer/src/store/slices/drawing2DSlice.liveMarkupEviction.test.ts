/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The session's per-model markup snapshots leave with their model
 * (implicit-state-machines persistence follow-up). Model ids ARE reused
 * (`room:<id>` for a collab room, an explicit id from a flow), so a snapshot
 * outliving its model was handed, synchronously, to the next model given that
 * id: a rejoined room showed the markup of the session it left.
 */
import { beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { __resetLiveMarkupCacheForTests } from './drawing2DSlice.markupTransition.js';
import type { Measure2DResult } from './drawing2DSlice.js';

const measure = (id: string): Measure2DResult => ({ id, start: { x: 0, y: 0 }, end: { x: 3, y: 4 }, distance: 5 });
const s = () => useViewerStore.getState();
const markupIds = () => s().measure2DResults.map((m) => m.id);

/** `room:1` is active with a measurement, then the user switches to `other`, so `room:1` is snapshotted. */
function leaveRoomWithMarkup(): void {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('room:1'), fixtureModel('other')), measure2DResults: [measure('old')] });
  s().setActiveModel('other');
  assert.deepEqual(markupIds(), []);
}

beforeEach(() => {
  __resetLiveMarkupCacheForTests();
  s().resetViewerState();
});

it('a removed model\'s markup is not handed to the next model with its id', () => {
  leaveRoomWithMarkup();
  s().removeModel('room:1');
  useViewerStore.setState({ models: new Map([...s().models, ['room:1', fixtureModel('room:1')]]) });
  s().setActiveModel('room:1');
  assert.deepEqual(markupIds(), [], 'the rejoined room starts without the old session\'s markup');
});

// Ordering (`modelSlice.sessionRelease.ts`): removing the ACTIVE model runs
// the markup transition inside `removeModel`'s set, which snapshots that
// model's markup. A release before the set would be undone by that snapshot.
it('removing the active model does not leave its markup for the next model with its id', () => {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('room:1'), fixtureModel('other')), measure2DResults: [measure('old')] });
  assert.equal(s().activeModelId, 'room:1');
  s().removeModel('room:1');
  assert.equal(s().activeModelId, 'other');
  useViewerStore.setState({ models: new Map([...s().models, ['room:1', fixtureModel('room:1')]]) });
  s().setActiveModel('room:1');
  assert.deepEqual(markupIds(), [], 'the active model\'s snapshot left with it');
});

it('clearing every model forgets every snapshot', () => {
  leaveRoomWithMarkup();
  s().clearAllModels();
  useViewerStore.setState(fixtureModels(fixtureModel('other'), fixtureModel('room:1')));
  s().setActiveModel('room:1');
  assert.deepEqual(markupIds(), []);
});

it('a session reset forgets every snapshot', () => {
  leaveRoomWithMarkup();
  s().resetViewerState();
  useViewerStore.setState(fixtureModels(fixtureModel('other'), fixtureModel('room:1')));
  s().setActiveModel('room:1');
  assert.deepEqual(markupIds(), []);
});

it('removing another, inactive model keeps a loaded model\'s snapshot', () => {
  leaveRoomWithMarkup();
  useViewerStore.setState({ models: new Map([...s().models, ['third', fixtureModel('third')]]) });
  s().removeModel('third');
  s().setActiveModel('room:1');
  assert.deepEqual(markupIds(), ['old']);
});
