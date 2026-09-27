/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The modeling command runtime + session slice (charter #6232, WP2): Escape
 * once resets the gesture and twice leaves the command, typed fields are
 * walked with Tab, and a command ends whenever the tool or session does.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { cleanup, press, render, type } from '@/test/render.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import type { SnapResult, Vec2 } from '@/lib/snap/types';
import { CommandFieldsBar } from '@/components/viewer/tools/command/CommandFieldsBar';
import { registerModelingCommand } from './registry.js';
import { commandPointerDown, commandPointerMove, getCommandRuntime } from './runtime.js';
import type { ModelingCommand } from './types.js';

interface Polyline { points: Vec2[]; cursor: Vec2 | null; length: number | null; angle: number | null }

const commits: Polyline[] = [];

const POLYLINE: ModelingCommand<Polyline> = {
  id: 'test.polyline',
  labelKey: 'modelingCommand.closeAria',
  hud: {},
  snap: 'modeling',
  fields: [
    { id: 'length', labelKey: 'modelingCommand.unit.m', unit: 'm', read: (g) => g.length, write: (g, v) => ({ ...g, length: v }) },
    { id: 'angle', labelKey: 'modelingCommand.unit.deg', unit: 'deg', read: (g) => g.angle, write: (g, v) => ({ ...g, angle: v }) },
  ],
  init: () => ({ points: [], cursor: null, length: null, angle: null }),
  pointerMove: (g, s) => ({ ...g, cursor: s.local }),
  pointerDown: (g, s) => ({ ...g, points: [...g.points, s.local] }),
  undoPoint: (g) => ({ ...g, points: g.points.slice(0, -1) }),
  commit: (g) => { commits.push(g); return { created: [], deleted: [], remesh: [] }; },
};

const at = (x: number, y: number): SnapResult => ({ local: [x, y], winner: null, guides: [], locked: false });
const gesture = () => getCommandRuntime().gesture as Polyline;
const key = (name: string) => press(document.body, name);

let unregister: () => void = () => {};
beforeEach(async () => {
  await seedModelingSession();
  commits.length = 0;
  unregister = registerModelingCommand(POLYLINE);
});
afterEach(() => {
  useViewerStore.getState().exitModelWorkspace();
  unregister();
  cleanup();
});

describe('modeling command session (#6232 WP2)', () => {
  it('startCommand enters the Model workspace on the session model and storey', () => {
    useViewerStore.getState().startCommand('test.polyline');
    const s = useViewerStore.getState();
    assert.equal(s.workspaceMode, 'model');
    assert.equal(s.activeTool, 'command');
    assert.equal(s.editEnabled, true);
    assert.equal(s.session?.modelId, MODEL_ID);
    assert.equal(s.session?.storeyId, STOREY);
    assert.deepEqual(s.session?.workplane, { kind: 'storey', storeyId: STOREY, offset: 0 });
    assert.equal(s.session?.activeCommandId, 'test.polyline');
    assert.equal(getCommandRuntime().command?.id, 'test.polyline');
  });

  it('Escape once resets the gesture, twice leaves the command', () => {
    useViewerStore.getState().startCommand('test.polyline');
    commandPointerMove(at(1, 1));
    commandPointerDown(at(1, 1));
    commandPointerDown(at(2, 1));
    assert.equal(gesture().points.length, 2);
    assert.equal(useViewerStore.getState().session?.phase, 'gesture');

    key('Escape');
    assert.equal(gesture().points.length, 0, 'first Escape resets');
    assert.equal(useViewerStore.getState().activeTool, 'command', 'and keeps the command');
    assert.equal(useViewerStore.getState().session?.phase, 'idle');

    key('Escape');
    const s = useViewerStore.getState();
    assert.equal(s.activeTool, 'select', 'second Escape leaves the command');
    assert.equal(s.session?.activeCommandId, null);
    assert.equal(s.workspaceMode, 'model', 'the workspace stays open');
    assert.equal(getCommandRuntime().command, null);
    assert.equal(s.selectedEntityId, null);
  });

  it('Enter commits and Backspace drops the last point', () => {
    useViewerStore.getState().startCommand('test.polyline');
    commandPointerDown(at(0, 0));
    commandPointerDown(at(3, 0));
    key('Backspace');
    assert.equal(gesture().points.length, 1);
    key('Enter');
    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0].points, [[0, 0]]);
    assert.equal(gesture().points.length, 0, 'a fresh gesture follows the commit');
  });

  it('switching tools ends the command and its keys', () => {
    useViewerStore.getState().startCommand('test.polyline');
    commandPointerDown(at(0, 0));
    useViewerStore.getState().setActiveTool('measure');
    assert.equal(getCommandRuntime().command, null);
    assert.equal(useViewerStore.getState().session?.activeCommandId, null);
    key('Enter');
    assert.equal(commits.length, 0, 'Enter no longer commits');
  });

  it('removing the session model closes the session and the command', () => {
    useViewerStore.getState().startCommand('test.polyline');
    useViewerStore.getState().removeModel(MODEL_ID);
    const s = useViewerStore.getState();
    assert.equal(s.session, null);
    assert.equal(s.workspaceMode, 'view');
    assert.equal(s.activeTool, 'select');
    assert.equal(getCommandRuntime().command, null);
  });

  it('Tab walks the typed fields and a digit opens the active one', () => {
    useViewerStore.getState().startCommand('test.polyline');
    const ui = render(<CommandFieldsBar />);
    assert.equal(ui.querySelector('input'), null);

    key('Tab');
    let input = ui.querySelector('input') as HTMLInputElement;
    assert.equal(input.getAttribute('aria-label'), 'm', 'Tab opens the first field');
    type(input, '3.5');
    press(input, 'Tab');
    assert.equal(gesture().length, 3.5, 'Tab applies the typed length');

    input = ui.querySelector('input') as HTMLInputElement;
    assert.equal(input.getAttribute('aria-label'), '°', 'and moves on to the angle');
    type(input, '90');
    press(input, 'Enter');
    assert.equal(gesture().angle, null, 'Enter commits, which starts a fresh gesture');
    assert.equal(commits.length, 1);
    assert.equal(commits[0].length, 3.5);
    assert.equal(commits[0].angle, 90);

    key('4');
    input = ui.querySelector('input') as HTMLInputElement;
    assert.equal(input.value, '4', 'a digit opens the field with that digit');
  });
});
