/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Undo and redo publish to the collab room what the forward edit published (#10695). Without this, a peer keeps
 * the value the local user just undid.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PropertyValueType } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { WALL_ID, model, parseHelloWall, seed } from '@/test/agent-tools-fixture';

const initial = useViewerStore.getState();
/** A fresh session handle: undo replays inside its transaction. */
const session = () => ({ roomId: 'room-a', transact: (run: () => void) => run() }) as never;
let mirrored: unknown[][];
beforeEach(async () => {
  seed([model('hello', await parseHelloWall())]);
  mirrored = [];
  useViewerStore.setState({
    // 'hello' is the room's model, so its edits are mirrored; the mirrors are spies.
    collabRoomId: 'room-a', collabSession: session(), collabRoomModels: new Map([['hello', { slotId: 'm0', pathPrefix: '/m0' }]]),
    mirrorPropertyEdit: (...args) => { mirrored.push(['edit', ...args]); },
    mirrorPropertyDelete: (...args) => { mirrored.push(['delete', ...args]); },
    mirrorAttributeEdit: (...args) => { mirrored.push(['attribute', ...args]); },
  });
});
afterEach(() => useViewerStore.setState(initial));
const state = () => useViewerStore.getState();
/** The mirror calls an action made, cleared for the next step. */
const take = () => mirrored.splice(0);

describe('undo and redo publish what the forward edit published (#10695)', () => {
  it('a property update: undo restores the old value, redo the new one', () => {
    state().setProperty('hello', WALL_ID, 'Pset_Custom', 'FireRating', 'REI30', PropertyValueType.String);
    state().setProperty('hello', WALL_ID, 'Pset_Custom', 'FireRating', 'REI60', PropertyValueType.String);
    take();
    state().undo('hello');
    assert.deepEqual(take(), [['edit', 'hello', WALL_ID, 'Pset_Custom', 'FireRating', 'REI30', PropertyValueType.String, undefined]]);
    state().redo('hello');
    assert.deepEqual(take(), [['edit', 'hello', WALL_ID, 'Pset_Custom', 'FireRating', 'REI60', PropertyValueType.String, undefined]]);
  });

  it('a created property is removed on undo, and a deleted one returns with its own type', () => {
    state().setProperty('hello', WALL_ID, 'Pset_Custom', 'IsLoadBearing', true, PropertyValueType.Boolean);
    take();
    state().undo('hello');
    assert.deepEqual(take(), [['delete', 'hello', WALL_ID, 'Pset_Custom', 'IsLoadBearing']]);
    state().redo('hello');
    take();
    state().deleteProperty('hello', WALL_ID, 'Pset_Custom', 'IsLoadBearing');
    take();
    state().undo('hello');
    assert.deepEqual(take(), [['edit', 'hello', WALL_ID, 'Pset_Custom', 'IsLoadBearing', true, PropertyValueType.Boolean, undefined]]);
    state().redo('hello');
    assert.deepEqual(take(), [['delete', 'hello', WALL_ID, 'Pset_Custom', 'IsLoadBearing']]);
  });

  it('an attribute edit: undo restores the recorded prior value, redo the new one', () => {
    state().setAttribute('hello', WALL_ID, 'Name', 'Renamed', 'Before');
    take();
    state().undo('hello');
    assert.deepEqual(take(), [['attribute', 'hello', WALL_ID, 'Name', 'Before']]);
    state().redo('hello');
    assert.deepEqual(take(), [['attribute', 'hello', WALL_ID, 'Name', 'Renamed']]);
    // With no recorded prior value the original is not known here: the undo stays local and says so.
    useViewerStore.setState({ collabGeometryNotice: null });
    state().setAttribute('hello', WALL_ID, 'Description', 'Typed');
    take();
    state().undo('hello');
    assert.deepEqual(take(), []);
    assert.match(state().collabGeometryNotice ?? '', /undo was applied locally, but could not be shared/);
  });

  it('an edit the room never received is not published on undo', () => {
    // Written straight to the view, as a draft-editor command does: nothing was mirrored, so nothing is undone remotely.
    const view = state().getMutationView('hello')!;
    const mutation = view.setProperty(WALL_ID, 'Pset_Custom', 'Note', 'local', PropertyValueType.String);
    useViewerStore.setState({ undoStacks: new Map([['hello', [mutation]]]) });
    state().undo('hello');
    assert.deepEqual(take(), []);
  });

  it('after leaving the session, even to rejoin the same room, an earlier edit is undone locally only', () => {
    state().setProperty('hello', WALL_ID, 'Pset_Custom', 'FireRating', 'REI30', PropertyValueType.String);
    take();
    // A rejoin is a new session: peers may have changed the value meanwhile, without invalidating this history.
    useViewerStore.setState({ collabSession: session() });
    state().undo('hello');
    assert.deepEqual(take(), []);
  });

  it('a publication the room refuses does not stop the undo', () => {
    state().setProperty('hello', WALL_ID, 'Pset_Custom', 'FireRating', 'REI30', PropertyValueType.String);
    state().setProperty('hello', WALL_ID, 'Pset_Custom', 'FireRating', 'REI60', PropertyValueType.String);
    useViewerStore.setState({ mirrorPropertyEdit: () => { throw new Error('the room rejects this value'); }, collabGeometryNotice: null });
    state().undo('hello');
    assert.equal(state().undoStacks.get('hello')?.length, 1);
    assert.equal(state().redoStacks.get('hello')?.length, 1, 'the step moved to the redo stack');
    const restored = state().getMutationView('hello')!.getForEntity(WALL_ID).find(set => set.name === 'Pset_Custom')?.properties.find(p => p.name === 'FireRating');
    assert.equal(restored?.value, 'REI30', 'the local undo applied');
    assert.match(state().collabGeometryNotice ?? '', /undo was applied locally, but could not be shared/);
  });

  it('an edit made outside a room is not published when undone later in one', () => {
    const live = state().collabSession;
    useViewerStore.setState({ collabRoomId: null, collabSession: null });
    state().setProperty('hello', WALL_ID, 'Pset_Custom', 'FireRating', 'REI30', PropertyValueType.String);
    take();
    useViewerStore.setState({ collabRoomId: 'room-a', collabSession: live });
    state().undo('hello');
    assert.deepEqual(take(), []);
  });

  it('a participant who can no longer edit undoes locally only', () => {
    state().setProperty('hello', WALL_ID, 'Pset_Custom', 'FireRating', 'REI30', PropertyValueType.String);
    take();
    useViewerStore.setState({ canCollabEdit: () => false });
    state().undo('hello');
    assert.deepEqual(take(), []);
  });
});
