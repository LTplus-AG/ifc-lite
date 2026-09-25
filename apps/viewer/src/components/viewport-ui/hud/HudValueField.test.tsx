/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { act } from 'react';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, press, type } from '@/test/render.js';
import { HudValueField } from './HudValueField.js';

afterEach(() => {
  cleanup();
});

/** A controlled harness: `HudValueField` is controlled, so the test owns
 *  the value and re-renders on every `onChange`, the way a real caller
 *  (a store-backed distance field) would. */
function Harness({ onChange, ...rest }: {
  onChange: (next: number) => void; value: number; step?: number; min?: number; max?: number; unit?: string;
  snaps?: readonly number[]; snapTolerance?: number; onScrubStart?: () => void; onScrubEnd?: () => void;
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
