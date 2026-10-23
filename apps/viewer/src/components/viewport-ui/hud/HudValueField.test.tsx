/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { act } from 'react';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, blur, press, type } from '@/test/render.js';
import { HudValueField, parseTypedNumber, type HudValueFieldHandle } from './HudValueField.js';

afterEach(() => {
  cleanup();
});

/** A controlled harness: `HudValueField` is controlled, so the test owns
 *  the value and re-renders on every `onChange`, the way a real caller
 *  (a store-backed distance field) would. */
function Harness({ onChange, ...rest }: {
  onChange: (next: number) => void; value: number; step?: number; min?: number; max?: number; unit?: string;
  snaps?: readonly number[]; snapTolerance?: number; wheelStep?: boolean; shiftMultiplier?: number; onScrubStart?: () => void; onScrubEnd?: () => void;
}) {
  return (
    <HudValueField
      {...rest}
      aria-label="Distance"
      onChange={(next) => onChange(next)}
    />
  );
}

function pointerDown(el: Element, clientX: number, pointerId = 1) {
  act(() => {
    el.dispatchEvent(
      new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX, pointerId, button: 0 }),
    );
  });
}
function pointerMove(el: Element, clientX: number, pointerId = 1) {
  act(() => {
    el.dispatchEvent(
      new window.PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX, pointerId }),
    );
  });
}
function pointerUp(el: Element, clientX: number, pointerId = 1) {
  act(() => {
    el.dispatchEvent(
      new window.PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX, pointerId }),
    );
  });
}

describe('HudValueField (#5485)', () => {
  it('drags horizontally to scrub the value by whole steps', () => {
    const values: number[] = [];
    const ui = render(<Harness value={10} step={1} onChange={(v) => values.push(v)} />);
    const field = ui.querySelector('[role="spinbutton"]')!;
    Object.defineProperty(field, 'setPointerCapture', { configurable: true, value: () => {} });

    pointerDown(field, 100);
    // Default scrub sensitivity is 6px/step; 30px right is +5 steps.
    pointerMove(field, 130);
    pointerUp(field, 130);

    assert.ok(values.length > 0, 'scrubbing produced at least one onChange');
    assert.equal(values[values.length - 1], 15);
  });

  it('clicking without dragging opens type-to-set, and Enter commits the typed value', () => {
    const values: number[] = [];
    const ui = render(<Harness value={10} step={1} onChange={(v) => values.push(v)} />);
    let field = ui.querySelector('[role="spinbutton"]')!;
    Object.defineProperty(field, 'setPointerCapture', { configurable: true, value: () => {} });

    // A press-release with no movement in between is a click, not a scrub.
    pointerDown(field, 50);
    pointerUp(field, 50);

    const input = ui.querySelector('input');
    assert.ok(input, 'clicking opens the type-to-set input');
    assert.equal(input!.value, '10.00');

    type(input!, '42.5');
    press(input!, 'Enter');

    assert.deepEqual(values, [42.5]);
    // Back to the read-only spinbutton once committed.
    field = ui.querySelector('[role="spinbutton"]')!;
    assert.ok(field);
    assert.equal(ui.querySelector('input'), null);
  });

  it('Escape cancels an in-progress edit without calling onChange', () => {
    const values: number[] = [];
    const ui = render(<Harness value={10} step={1} onChange={(v) => values.push(v)} />);
    const field = ui.querySelector('[role="spinbutton"]')!;
    Object.defineProperty(field, 'setPointerCapture', { configurable: true, value: () => {} });
    pointerDown(field, 50);
    pointerUp(field, 50);

    const input = ui.querySelector('input')!;
    type(input, '999');
    press(input, 'Escape');

    assert.deepEqual(values, []);
    assert.ok(ui.querySelector('[role="spinbutton"]'));
  });

  it('an edit left untouched commits nothing on blur or Tab; a typed one still does (#6232 F1)', () => {
    const values: number[] = [];
    const tabs: boolean[] = [];
    let handle: HudValueFieldHandle | null = null;
    const ui = render(
      <HudValueField ref={(h) => { handle = h; }} value={0} aria-label="Length" onChange={(v) => values.push(v)} onTab={(s) => tabs.push(s)} />,
    );
    act(() => handle!.beginEdit());
    blur(ui.querySelector('input')!);
    act(() => handle!.beginEdit());
    press(ui.querySelector('input')!, 'Tab');
    assert.deepEqual(values, [], 'an opened-but-untouched field writes nothing');
    assert.deepEqual(tabs, [false], 'Tab still moves on');

    act(() => handle!.beginEdit());
    type(ui.querySelector('input')!, '4');
    blur(ui.querySelector('input')!);
    act(() => handle!.beginEdit('7'));
    press(ui.querySelector('input')!, 'Tab');
    assert.deepEqual(values, [4, 7], 'typed drafts (incl. a digit typed elsewhere) commit');
  });

  it('arrow keys step the value, and Shift steps by the shift multiplier', () => {
    const values: number[] = [];
    const ui = render(<Harness value={10} step={1} onChange={(v) => values.push(v)} />);
    const field = ui.querySelector('[role="spinbutton"]')!;

    press(field, 'ArrowUp');
    press(field, 'ArrowDown');
    press(field, 'ArrowUp', { shiftKey: true });

    // Each keydown reads the LATEST `value` off the still-uncontrolled
    // harness (value stays 10 across presses — Harness doesn't feed
    // onChange back into its own `value` prop), so all three deltas are
    // relative to the same starting point: 11, 9, 20.
    assert.deepEqual(values, [11, 9, 20]);
  });

  it('clamps to min/max on both drag and arrow-key paths', () => {
    const values: number[] = [];
    const ui = render(<Harness value={9} step={1} max={10} onChange={(v) => values.push(v)} />);
    const field = ui.querySelector('[role="spinbutton"]')!;
    Object.defineProperty(field, 'setPointerCapture', { configurable: true, value: () => {} });

    press(field, 'ArrowUp');
    press(field, 'ArrowUp');
    assert.deepEqual(values, [10, 10]);

    values.length = 0;
    pointerDown(field, 0);
    pointerMove(field, 1000);
    pointerUp(field, 1000);
    // `every` on an empty array is vacuously true, so a drag path that
    // stopped calling `onChange` entirely would pass the bound check below
    // without ever being caught — require at least one result first.
    assert.ok(values.length > 0, 'the drag produced at least one onChange');
    assert.ok(values.every((v) => v <= 10));
  });

  it('exposes the value and unit through aria-valuetext for assistive tech', () => {
    const ui = render(<Harness value={1.2} step={0.1} unit=" m" onChange={() => {}} />);
    const field = ui.querySelector('[role="spinbutton"]')!;
    assert.equal(field.getAttribute('aria-valuenow'), '1.2');
    assert.equal(field.getAttribute('aria-valuetext'), '1.20 m');
    assert.equal(field.getAttribute('aria-label'), 'Distance');
  });

  it('a scrub snaps onto a snap point inside its catchment; arrow keys and typing never snap (#5499)', () => {
    const values: number[] = [];
    const ui = render(<Harness value={10} step={1} snaps={[12.4]} snapTolerance={0.5} onChange={(v) => values.push(v)} />);
    const field = ui.querySelector('[role="spinbutton"]')!;
    Object.defineProperty(field, 'setPointerCapture', { configurable: true, value: () => {} });

    pointerDown(field, 100);
    pointerMove(field, 112); // +2 steps = 12, within 0.5 of 12.4
    pointerMove(field, 130); // +5 steps = 15, outside the catchment
    pointerUp(field, 130);
    assert.deepEqual(values, [12.4, 15]);

    values.length = 0;
    press(field, 'ArrowUp');
    press(field, 'ArrowUp');
    assert.deepEqual(values, [11, 11], 'a keyboard step is exact even when a snap is within reach');
  });

  it('reports the start and end of a scrub, but not of a click', () => {
    const events: string[] = [];
    const ui = render(
      <Harness value={10} step={1} onChange={() => {}} onScrubStart={() => events.push('start')} onScrubEnd={() => events.push('end')} />,
    );
    const field = ui.querySelector('[role="spinbutton"]')!;
    Object.defineProperty(field, 'setPointerCapture', { configurable: true, value: () => {} });

    pointerDown(field, 50);
    pointerUp(field, 50);
    assert.deepEqual(events, [], 'a click opens type-to-set without a scrub lifecycle');

    press(ui.querySelector('input')!, 'Escape');
    const again = ui.querySelector('[role="spinbutton"]')!;
    Object.defineProperty(again, 'setPointerCapture', { configurable: true, value: () => {} });
    pointerDown(again, 50);
    pointerMove(again, 60);
    pointerMove(again, 70);
    pointerUp(again, 70);
    assert.deepEqual(events, ['start', 'end'], 'one start per scrub, one end on release');
  });
});

/** A wheel notch the way a browser delivers it: bubbling and cancelable, so `defaultPrevented` tells whether the page would scroll. */
function wheel(el: Element, deltaY: number, init: WheelEventInit = {}): WheelEvent {
  // A plain event with the wheel fields defined on it: the DOM shim does not carry modifier keys through WheelEventInit.
  const event = new window.Event('wheel', { bubbles: true, cancelable: true }) as unknown as WheelEvent;
  for (const [key, value] of Object.entries({ deltaY, shiftKey: false, altKey: false, ...init })) {
    Object.defineProperty(event, key, { value });
  }
  act(() => { el.dispatchEvent(event); });
  return event;
}

describe('HudValueField wheel stepping (#7545)', () => {
  const mount = (props: { value: number; step?: number; min?: number; max?: number; wheelStep?: boolean }, values: number[]) => {
    const ui = render(<Harness {...props} onChange={(v) => values.push(v)} />);
    return ui.querySelector('[role="spinbutton"]')!;
  };

  it('one notch is one step, up increases, and the notch\'s size is ignored', () => {
    const values: number[] = [];
    const field = mount({ value: 1, step: 0.1, wheelStep: true }, values);
    wheel(field, -1);
    wheel(field, -400);
    wheel(field, 3);
    assert.deepEqual(values.map((v) => Number(v.toFixed(6))), [1.1, 1.1, 0.9]);
  });

  it('holds the page and the camera: the event is cancelled and does not bubble to the viewport', () => {
    const values: number[] = [];
    const field = mount({ value: 0, wheelStep: true }, values);
    let reachedViewport = false;
    document.body.addEventListener('wheel', () => { reachedViewport = true; }, { once: true });
    const event = wheel(field, -100);
    assert.equal(event.defaultPrevented, true);
    assert.equal(reachedViewport, false);
  });

  it('Shift multiplies the step by the field\'s multiplier, Alt divides it by ten', () => {
    const values: number[] = [];
    const field = mount({ value: 5, step: 1, wheelStep: true }, values);
    wheel(field, -1, { shiftKey: true });
    wheel(field, -1, { altKey: true });
    assert.deepEqual(values, [15, 5.1]);
  });

  it('Shift+wheel that the platform reports as a horizontal delta still steps', () => {
    const values: number[] = [];
    const field = mount({ value: 1, step: 1, wheelStep: true }, values);
    wheel(field, 0, { deltaX: -120 } as WheelEventInit);
    assert.deepEqual(values, [2]);
  });

  it('commits only what was typed as a number: a comma is a decimal point, trailing text is not a number', () => {
    for (const [typed, expected] of [['-0,2', -0.2], ['1.5', 1.5], ['  7 ', 7], ['+3', 3], ['.5', 0.5]] as const) {
      assert.equal(parseTypedNumber(typed), expected, typed);
    }
    for (const typed of ['-200 mm', '1.2.3', '', '-', 'abc', '1e3', '0x10', '1,2,3', '--1']) {
      assert.equal(parseTypedNumber(typed), null, typed);
    }
  });

  it('clamps to min and max, and a zero delta does nothing', () => {
    const values: number[] = [];
    const field = mount({ value: 9.95, step: 0.1, max: 10, min: 0, wheelStep: true }, values);
    wheel(field, -1);
    wheel(field, 0);
    assert.deepEqual(values, [10]);
  });

  it('is off unless asked for, and off while the value is being typed', () => {
    const values: number[] = [];
    const field = mount({ value: 1, step: 1 }, values);
    const event = wheel(field, -1);
    assert.deepEqual(values, []);
    assert.equal(event.defaultPrevented, false, 'without wheelStep the wheel is not claimed');

    cleanup();
    const typing: number[] = [];
    const f = mount({ value: 1, step: 1, wheelStep: true }, typing);
    press(f, 'Enter');
    const input = document.querySelector('input')!;
    wheel(input, -1);
    assert.deepEqual(typing, [], 'a wheel over the open text field does not step');
  });
});
