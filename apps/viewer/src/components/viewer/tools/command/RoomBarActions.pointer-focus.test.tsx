/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { useEffect } from 'react';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { activate, cleanup, click, press, render } from '@/test/render.js';
import { registerKeyboardCommand } from '@/lib/commands/dispatcher';
import * as actions from './RoomBarActions';

afterEach(cleanup);

// Review of #9257 (#9233): the Room bar's Auto / Space envelope / Update /
// Cleanup buttons kept focus after a click, so Enter re-ran the action instead
// of committing the room being drawn.
function Bar({ onAction, onCommit }: { onAction: () => void; onCommit: () => void }) {
  const { BarAction } = actions;
  useEffect(() => registerKeyboardCommand('command.commit', () => { onCommit(); }), [onCommit]);
  return <BarAction onClick={onAction} title="Update" icon={null}>Update</BarAction>;
}

it('exports the room bar action button (#9233)', () => {
  assert.equal(typeof actions.BarAction, 'function');
});

it('Enter commits the room after a mouse click on a bar action (#9233)', () => {
  let runs = 0;
  let commits = 0;
  const ui = render(<Bar onAction={() => { runs++; }} onCommit={() => { commits++; }} />);
  const button = ui.querySelector('button')!;
  button.focus();
  click(button, { detail: 1 });
  assert.equal(runs, 1, 'the click ran the action');
  assert.notEqual(document.activeElement, button, 'the pointer click handed focus back');
  press((document.activeElement ?? document.body) as HTMLElement, 'Enter');
  assert.equal(commits, 1, 'Enter committed the running command');
  assert.equal(runs, 1, 'Enter did not run the action again');
});

it('a keyboard-activated bar action keeps focus and keeps Enter (#9233)', () => {
  let runs = 0;
  let commits = 0;
  const ui = render(<Bar onAction={() => { runs++; }} onCommit={() => { commits++; }} />);
  const button = ui.querySelector('button')!;
  activate(button, 'Enter');
  assert.equal(document.activeElement, button, 'keyboard activation keeps focus on the action');
  assert.equal(runs, 1, 'Enter pressed the focused action');
  assert.equal(commits, 0, 'not the command');
});
