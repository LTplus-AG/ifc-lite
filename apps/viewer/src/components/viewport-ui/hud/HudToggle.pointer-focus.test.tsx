/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { useEffect, useState } from 'react';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { activate, cleanup, click, press, render } from '@/test/render.js';
import { registerKeyboardCommand } from '@/lib/commands/dispatcher';
import * as toggleModule from './HudToggle';
import * as segmentedModule from './HudSegmented';

afterEach(cleanup);

// Review of #9257 (#9233): the dispatcher lets a focused button keep Enter, and
// Chromium leaves focus on a clicked button. A bar control clicked mid-command
// (Chain, a justification option) must hand focus back, or Enter re-presses it
// instead of committing the running command.
function Bar({ onCommit }: { onCommit: () => void }) {
  const { HudToggle } = toggleModule;
  const { HudSegmented } = segmentedModule;
  const [chain, setChain] = useState(false);
  const [side, setSide] = useState<'left' | 'right'>('left');
  useEffect(() => registerKeyboardCommand('command.commit', () => { onCommit(); }), [onCommit]);
  return (
    <div>
      <HudToggle pressed={chain} onPressedChange={() => setChain((on) => !on)}>Chain</HudToggle>
      <HudSegmented
        aria-label="Justification"
        value={side}
        onChange={setSide}
        options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]}
      />
    </div>
  );
}

const focused = () => (document.activeElement ?? document.body) as HTMLElement;

it('exports the pointer-focus release the bar controls share (#9233)', () => {
  assert.equal(typeof toggleModule.releasePointerFocus, 'function');
});

for (const control of ['toggle', 'segmented option'] as const) {
  it(`Enter commits after a mouse click on a ${control} (#9233)`, () => {
    let commits = 0;
    const ui = render(<Bar onCommit={() => { commits++; }} />);
    const button = control === 'toggle'
      ? ui.querySelector<HTMLButtonElement>('button[aria-pressed]')!
      : ui.querySelector<HTMLButtonElement>('button[role="radio"][aria-checked="false"]')!;
    button.focus();
    click(button, { detail: 1 });
    const state = control === 'toggle' ? 'aria-pressed' : 'aria-checked';
    assert.equal(button.getAttribute(state), 'true', 'the click applied the control');
    assert.notEqual(document.activeElement, button, 'the pointer click handed focus back');
    press(focused(), 'Enter');
    assert.equal(commits, 1, 'Enter committed the running command');
  });

  it(`a keyboard-activated ${control} keeps focus and keeps Enter (#9233)`, () => {
    let commits = 0;
    const ui = render(<Bar onCommit={() => { commits++; }} />);
    const button = control === 'toggle'
      ? ui.querySelector<HTMLButtonElement>('button[aria-pressed]')!
      : ui.querySelector<HTMLButtonElement>('button[role="radio"][aria-checked="false"]')!;
    activate(button, 'Enter');
    assert.equal(document.activeElement, button, 'keyboard activation keeps focus on the control');
    assert.equal(commits, 0, 'Enter pressed the focused control, not the command');
  });
}
