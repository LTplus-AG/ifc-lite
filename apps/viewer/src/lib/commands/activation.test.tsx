/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { useEffect } from 'react';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { activate, cleanup, press, render } from '@/test/render.js';
import { KEY_COMMANDS } from './keyboard-commands';
import { registerKeyboardCommand } from './dispatcher';

afterEach(cleanup);

// #9233: every registered plain Enter/Space command must yield, including
// Walk jump (ignoreModifiers) and a global fallback after a tool declines.
for (const definition of KEY_COMMANDS) {
  for (const chord of definition.keys) {
    if (!['enter', ' '].includes(chord.key) || chord.mod || chord.alt || chord.shift) continue;
    it(`${definition.id} yields focused control activation (#9233)`, () => {
      let commands = 0;
      let presses = 0;
      const events: string[] = [];
      function Owner() {
        useEffect(() => registerKeyboardCommand(definition.id, () => { commands++; }, { ignoreModifiers: true }), []);
        return <button onClick={() => { presses++; events.push('click'); }} onKeyUp={() => { events.push('keyup'); }}>Panel action</button>;
      }
      const ui = render(<Owner />);
      const button = ui.querySelector('button')!;
      activate(button, chord.key === 'enter' ? 'Enter' : ' ');
      assert.equal(presses, 1, 'the button action ran');
      assert.equal(commands, 0, 'the global command did not run');
      assert.deepEqual(events, chord.key === 'enter' ? ['click', 'keyup'] : ['keyup', 'click']);
      press(document.body, chord.key === 'enter' ? 'Enter' : ' ');
      assert.equal(commands, 1, 'the canvas shortcut still works');
    });
  }
}

for (const kind of ['summary', 'role', 'link'] as const) {
  it(`Enter yields to a focused ${kind}, including nested targets (#9233)`, () => {
    let commands = 0;
    let actions = 0;
    function Owner() {
      useEffect(() => registerKeyboardCommand('command.commit', () => { commands++; }), []);
      // Happy DOM omits native summary/link default activation. Model that
      // default only when dispatch permits it; custom roles handle keys.
      const content = <span>Activate</span>;
      if (kind === 'role') return <div role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') actions++; }}>{content}</div>;
      if (kind === 'link') return <a href="#9233" onClick={(e) => { e.preventDefault(); actions++; }}>{content}</a>;
      return <details onToggle={() => { actions++; }}><summary>{content}</summary></details>;
    }
    const ui = render(<Owner />);
    const control = ui.querySelector<HTMLElement>('summary, [role=button], a')!;
    control.focus();
    const event = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    const allowed = control.querySelector('span')!.dispatchEvent(event);
    assert.equal(allowed, true, 'native activation is permitted');
    if (kind === 'link') control.click();
    if (kind === 'summary') {
      const details = ui.querySelector('details')!;
      details.open = !details.open;
      assert.equal(details.open, true);
    } else assert.equal(actions, 1, 'the control action ran');
    assert.equal(commands, 0, 'Enter did not commit');
  });
}
