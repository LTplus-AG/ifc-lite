/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The command bar's two forms (#6232 M2.2). A placing command's bar (Beam:
 * five fields, a class segment, Chain) is wider than the top-center lane in
 * most layouts; held on one row it ran under the storey chip and the
 * ViewCube. The fallback stacks it with the name and ✕ on the first row. The
 * offscreen copy the bar measures must never take a typed value.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { cleanup, press, render } from '@/test/render.js';
import { seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin';
import { CommandBar, CommandBarContent } from './CommandHud';

beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.getState().startCommand('beam.place');
});
afterEach(() => {
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
});

describe('command bar tiers (#6232 M2.2)', () => {
  it('a typed digit opens the visible bar\'s field, never the measured copy', () => {
    const ui = render(<CommandBar />);
    // Without the guard the hidden copy opens first and loses focus to the
    // visible one, so the end state alone would look right: watch focus itself.
    const hiddenFocus: Element[] = [];
    const onFocus = (e: Event) => { if ((e.target as Element).closest('[aria-hidden="true"]')) hiddenFocus.push(e.target as Element); };
    document.addEventListener('focusin', onFocus);
    press(document.body, '3');
    document.removeEventListener('focusin', onFocus);
    assert.deepEqual(hiddenFocus, [], 'the measured copy never took focus');
    const inputs = [...ui.querySelectorAll('input')];
    assert.equal(inputs.length, 1, 'exactly one field opened');
    assert.ok(inputs[0].closest('[data-command-id="beam.place"]'), 'in the visible bar');
    assert.equal(inputs[0].closest('[aria-hidden="true"]'), null);
    assert.equal(inputs[0].value, '3');
  });

  it('the stacked form keeps the name and ✕ together on the first row, fields and controls below', () => {
    const ui = render(<CommandBarContent tier={1} />);
    const bar = ui.querySelector('[data-command-id="beam.place"]') as HTMLElement;
    assert.equal(bar.dataset.barTier, '1');
    const rows = [...bar.children] as HTMLElement[];
    assert.equal(rows.length, 3);
    assert.match(rows[0].textContent ?? '', /Beam/);
    assert.ok(rows[0].querySelector('button[aria-label]'), 'the close button is on the header row');
    assert.ok(rows[1].querySelector('[aria-label="Bottom at"]'), 'the fields row');
    assert.ok([...rows[2].querySelectorAll('button')].some((b) => b.textContent === 'Member'), 'the command\'s own controls row');
  });
});
