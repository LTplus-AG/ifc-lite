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
let mirrored: unknown[][];
beforeEach(async () => {
  seed([model('hello', await parseHelloWall())]);
  mirrored = [];
  useViewerStore.setState({
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

  it('an attribute edit: undo restores the prior value, or the source value when none was recorded', () => {
    state().setAttribute('hello', WALL_ID, 'Name', 'Renamed', 'Before');
    take();
    state().undo('hello');
    assert.deepEqual(take(), [['attribute', 'hello', WALL_ID, 'Name', 'Before']]);
    state().redo('hello');
    assert.deepEqual(take(), [['attribute', 'hello', WALL_ID, 'Name', 'Renamed']]);
    const source = state().models.get('hello')!.ifcDataStore!.getEntity!(WALL_ID)!.attributes[3];
    state().setAttribute('hello', WALL_ID, 'Description', 'Typed');
    take();
    state().undo('hello');
    assert.deepEqual(take(), [['attribute', 'hello', WALL_ID, 'Description', source ?? null]]);
  });

  it('an edit the room never received is not published on undo', () => {
    // Written straight to the view, as a draft-editor command does: nothing was mirrored, so nothing is undone remotely.
    const view = state().getMutationView('hello')!;
    const mutation = view.setProperty(WALL_ID, 'Pset_Custom', 'Note', 'local', PropertyValueType.String);
    useViewerStore.setState({ undoStacks: new Map([['hello', [mutation]]]) });
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
