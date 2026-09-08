/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Space Sketch keyboard ownership (#2438).
 *
 * The mechanism these pin is a single `true` argument. `useKeyboardShortcuts`
 * registers a window `keydown` listener in the BUBBLE phase; the sketch
 * registers in CAPTURE, so it runs first, and Escape additionally calls
 * `stopImmediatePropagation()`. Drop the capture flag or the
 * stopImmediatePropagation and:
 *
 * - the first Escape reaches the global handler, which closes the tool — every
 *   drafted room on every storey is discarded without a confirm;
 * - Ctrl+Z undoes the 3D model's last mutation instead of the sketch's last
 *   plate edit, so the panel's own Undo button and the shortcut disagree.
 *
 * Neither has a visible symptom in source review, so each test below asserts
 * through a BUBBLE-phase spy standing in for the global handler: the spy firing
 * IS the regression.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSpaceSketchKeys, DOUBLE_ESC_MS, type UseSpaceSketchKeysOptions } from './useSpaceSketchKeys.js';

interface Calls {
  undo: number;
  redo: number;
  closePopovers: number;
  abortCurrentOp: number;
  closeNow: number;
  commitDraw: number;
  modifiers: string[];
  status: string[];
}

let calls: Calls;
let root: Root | null = null;
let container: HTMLElement | null = null;
/** Stands in for `useKeyboardShortcuts`: a BUBBLE-phase window listener. */
let globalSpy: KeyboardEvent[] = [];
let onGlobal: ((e: KeyboardEvent) => void) | null = null;

function options(over: Partial<UseSpaceSketchKeysOptions> = {}): UseSpaceSketchKeysOptions {
  return {
    undo: () => { calls.undo++; },
    redo: () => { calls.redo++; },
    closePopovers: () => { calls.closePopovers++; return false; },
    abortCurrentOp: () => { calls.abortCurrentOp++; return false; },
    closeNow: () => { calls.closeNow++; },
    needsConfirm: false,
    setStatus: (s) => { calls.status.push(s); },
    commitDraw: null,
    onModifiers: (e) => { calls.modifiers.push(e.key); },
    ...over,
  };
}

function Harness(props: { opts: UseSpaceSketchKeysOptions }) {
  useSpaceSketchKeys(props.opts);
  return null;
}

function mount(opts: UseSpaceSketchKeysOptions): void {
  act(() => { root!.render(<Harness opts={opts} />); });
}

/** Dispatch a real key at `document.body`, so it propagates window→target→window. */
function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => { document.body.dispatchEvent(ev); });
  return ev;
}

function release(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    document.body.dispatchEvent(new window.KeyboardEvent('keyup', { key, bubbles: true, cancelable: true, ...init }));
  });
}

beforeEach(() => {
  calls = { undo: 0, redo: 0, closePopovers: 0, abortCurrentOp: 0, closeNow: 0, commitDraw: 0, modifiers: [], status: [] };
  globalSpy = [];
  onGlobal = (e: KeyboardEvent) => { globalSpy.push(e); };
  window.addEventListener('keydown', onGlobal); // bubble, like the real one
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (onGlobal) window.removeEventListener('keydown', onGlobal);
  onGlobal = null;
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
});

describe('useSpaceSketchKeys — Escape ownership', () => {
  it('takes the first Escape away from the global handler and does not close', () => {
    mount(options());
    press('Escape');
    assert.equal(globalSpy.length, 0, 'the global keydown handler must never see Escape');
    assert.equal(calls.closeNow, 0, 'a single Escape does not close the tool');
    assert.equal(calls.abortCurrentOp, 1, 'it offers itself to the in-progress op first');
    assert.deepEqual(calls.status, ['Press Esc again to close.']);
  });

  it('closes on a second Escape within the double-tap window', () => {
    mount(options());
    press('Escape');
    press('Escape');
    assert.equal(calls.closeNow, 1, 'the second Escape closes');
    assert.equal(globalSpy.length, 0, 'and neither one leaked to the global handler');
  });

  it('does not close when the second Escape lands after the window', async () => {
    mount(options());
    press('Escape');
    await act(async () => { await new Promise((r) => setTimeout(r, DOUBLE_ESC_MS + 60)); });
    press('Escape');
    assert.equal(calls.closeNow, 0, 'a late second Escape re-arms instead of closing');
    assert.equal(calls.status.length, 2);
  });

  it('spends Escape on an open popover, and re-arms the double-tap from scratch', () => {
    mount(options({ closePopovers: () => { calls.closePopovers++; return true; } }));
    press('Escape');
    assert.equal(calls.closePopovers, 1);
    assert.equal(calls.abortCurrentOp, 0, 'the popover consumed it before the op');
    assert.equal(calls.closeNow, 0);
  });

  it('spends Escape on the in-progress op, and that Escape does not count towards closing', () => {
    mount(options({ abortCurrentOp: () => { calls.abortCurrentOp++; return true; } }));
    press('Escape'); // aborts the draw
    press('Escape'); // must NOT close: the abort reset the double-tap clock
    assert.equal(calls.closeNow, 0, 'aborting an op must not arm the close');
    assert.equal(calls.abortCurrentOp, 2);
  });

  it('warns about unconfirmed drafts rather than closing silently', () => {
    mount(options({ needsConfirm: true }));
    press('Escape');
    assert.match(calls.status[0], /without creating/);
  });
});

describe('useSpaceSketchKeys — Ctrl/Cmd+Z ownership', () => {
  it('takes Ctrl+Z away from the global model-undo handler', () => {
    mount(options());
    press('z', { ctrlKey: true });
    assert.equal(calls.undo, 1, 'the sketch history handles it');
    assert.equal(globalSpy.length, 0, 'the model mutation stack never sees it');
  });

  it('routes Ctrl+Shift+Z to redo', () => {
    mount(options());
    press('z', { ctrlKey: true, shiftKey: true });
    assert.equal(calls.redo, 1);
    assert.equal(calls.undo, 0);
  });

  it('leaves a bare z alone', () => {
    mount(options());
    press('z');
    assert.equal(calls.undo, 0);
    assert.equal(globalSpy.length, 1, 'an unclaimed key still reaches the app');
  });

  it('leaves native field undo alone while typing', () => {
    mount(options());
    const input = document.createElement('input');
    document.body.appendChild(input);
    const ev = new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => { input.dispatchEvent(ev); });
    assert.equal(calls.undo, 0, 'the sketch does not steal undo from a text field');
    assert.equal(ev.defaultPrevented, false);
    input.remove();
  });
});

describe('useSpaceSketchKeys — Enter and modifiers', () => {
  it('closes the drawn room on Enter, and keeps Enter from the app', () => {
    mount(options({ commitDraw: () => { calls.commitDraw++; } }));
    press('Enter');
    assert.equal(calls.commitDraw, 1);
    assert.equal(globalSpy.length, 0);
  });

  it('leaves Enter alone when no draw is in progress', () => {
    mount(options());
    press('Enter');
    assert.equal(calls.commitDraw, 0);
    assert.equal(globalSpy.length, 1, 'Enter belongs to the app when nothing is drawn');
  });

  it('leaves Enter alone inside a text field even mid-draw', () => {
    mount(options({ commitDraw: () => { calls.commitDraw++; } }));
    const input = document.createElement('input');
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    assert.equal(calls.commitDraw, 0);
    input.remove();
  });

  it('repaints the hover preview on modifier down AND up, and on nothing else', () => {
    mount(options());
    press('Alt');
    release('Alt');
    press('Shift');
    press('a');
    assert.deepEqual(calls.modifiers, ['Alt', 'Alt', 'Shift'],
      'only modifier keys repaint, and a release repaints too');
  });

  it('detaches every listener on unmount', () => {
    mount(options());
    act(() => { root!.unmount(); });
    root = null;
    press('Escape');
    press('z', { ctrlKey: true });
    press('Alt');
    assert.equal(calls.closeNow + calls.undo + calls.abortCurrentOp + calls.modifiers.length, 0,
      'a closed tool listens for nothing');
    assert.equal(globalSpy.length, 3, 'and every key is handed back to the app');
  });
});
