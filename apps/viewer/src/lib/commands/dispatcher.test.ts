/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerKeyboardBinding,
  registerKeyboardCommand,
  registerKeyboardKeyUp,
} from './dispatcher.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.replaceChildren();
});

function key(target: EventTarget, value: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}

describe('layered keyboard dispatcher (#5841)', () => {
  it('ignores a popover-consumed key instead of clearing the global selection', () => {
    let cleared = 0;
    cleanups.push(registerKeyboardCommand('selection.escape', () => { cleared++; }));
    const event = new window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);
    assert.equal(cleared, 0);
  });

  it('lets the active modal own T and blocks the global theme shortcut', () => {
    let theme = 0;
    let modal = 0;
    cleanups.push(registerKeyboardCommand('ui.toggleTheme', () => { theme++; }));
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);
    const unregisterModal = registerKeyboardBinding({
      id: 'test.modal.t', when: 'overlay', layer: 'modal', keys: [{ key: 't' }],
      run: () => { modal++; },
    });
    cleanups.push(unregisterModal);
    assert.equal(key(window, 't').defaultPrevented, true);
    assert.equal(modal, 1);
    assert.equal(theme, 0);
    dialog.remove();
    unregisterModal();
    key(window, 't');
    assert.equal(theme, 1, 'global shortcut returns after the modal closes');
  });

  it('applies one text-entry guard while allowing an explicitly scoped command', () => {
    let theme = 0;
    let palette = 0;
    cleanups.push(registerKeyboardCommand('ui.toggleTheme', () => { theme++; }));
    cleanups.push(registerKeyboardCommand('ui.commandPalette', () => { palette++; }, { allowInTextEntry: true }));
    const input = document.createElement('input');
    document.body.append(input);
    key(input, 't');
    key(input, 'k', { ctrlKey: true });
    assert.equal(theme, 0);
    assert.equal(palette, 1);
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const content = document.createElement('div');
    editor.append(content);
    document.body.append(editor);
    key(content, 't');
    assert.equal(theme, 0, 'CodeMirror text remains owned by its editor');
  });

  it('delivers keyup after focus moves into text and the event was prevented', () => {
    const released: string[] = [];
    cleanups.push(registerKeyboardKeyUp((event) => released.push(event.key)));
    const input = document.createElement('input');
    document.body.append(input);
    const event = new window.KeyboardEvent('keyup', { key: 'w', bubbles: true, cancelable: true });
    event.preventDefault();
    input.dispatchEvent(event);
    assert.deepEqual(released, ['w']);
  });

  it('counts only global Escape presses toward close-all, after tool cancellation', () => {
    let toolActive = true;
    const calls: string[] = [];
    cleanups.push(registerKeyboardCommand('measure.cancel', () => { calls.push('tool'); toolActive = false; }, { active: () => toolActive }));
    cleanups.push(registerKeyboardCommand('selection.escape', () => { calls.push('selection'); }));
    cleanups.push(registerKeyboardCommand('ui.closeAllPanels', () => { calls.push('close-all'); }));
    key(window, 'Escape');
    key(window, 'Escape');
    key(window, 'Escape');
    assert.deepEqual(calls, ['tool', 'selection', 'close-all']);
  });

  it('uses the displayed command chord, including shifted printable keys and positional Alt digits', () => {
    let help = 0;
    let panel = 0;
    cleanups.push(registerKeyboardCommand('help.shortcuts', () => { help++; }));
    cleanups.push(registerKeyboardCommand('ui.openPanel', () => { panel++; }));
    key(window, '?', { shiftKey: true });
    key(window, '¡', { altKey: true, code: 'Digit1' });
    assert.equal(help, 1);
    assert.equal(panel, 1);
  });
});
